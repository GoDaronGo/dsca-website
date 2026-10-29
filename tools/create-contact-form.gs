/**
 * DSCA website contact form: Google Form + response sheet + Sender sync.
 *
 * One-time setup: run createDscaContactForm() from the Apps Script editor.
 * It creates the form and sheet, installs the on-submit trigger, and logs the
 * settings the website needs (formResponse URL + entry IDs) for site.json.
 *
 * Sender sync: each submission is added to Sender (sender.net) in the group
 * named SENDER_GROUP_NAME. The API token lives in Script Properties as
 * SENDER_TOKEN (Project Settings > Script Properties) — never in this code.
 */
var SENDER_GROUP_NAME = 'Website Sign-ups';

function createDscaContactForm() {
  var communities = ['Coronado', 'Catalina', 'Avalon', 'Balboa', 'Edgewater', 'Riva', 'Dockside', 'Ibiza', 'Other/Not Applicable'];
  var initiatives = ['Neighborhood Block Party', 'Parks and Beautification Projects', 'Community Meetings', 'Youth/Family Activities', 'Community Communications and Newsletter', 'Other'];
  var chatYes = 'Yes, please add me to the WhatsApp Chat Group.';
  var chatNo = 'No, I prefer not to join the WhatsApp Chat Group at this time.';
  var watchYes = 'Yes, I am interested in joining or learning more about the Block Watch.';
  var watchNo = 'No, thank you.';

  var form = FormApp.create('DSCA Contact & Involvement Form');
  form.setDescription('Submitted from deltashorescommunity.com/contact');
  form.setCollectEmail(false);
  form.setAllowResponseEdits(false);
  form.setLimitOneResponsePerUser(false);
  try { form.setRequireLogin(false); } catch (e) { Logger.log('setRequireLogin: ' + e); }
  form.setConfirmationMessage('Thank you! We look forward to engaging with you!');

  var items = {};
  items.first_name = form.addTextItem().setTitle('First name').setRequired(true);
  items.last_name = form.addTextItem().setTitle('Last name').setRequired(true);
  items.email = form.addTextItem().setTitle('Email').setRequired(true)
    .setValidation(FormApp.createTextValidation().requireTextIsEmail().build());
  items.phone = form.addTextItem().setTitle('Phone');
  items.address = form.addTextItem().setTitle('Street address');
  items.community = form.addListItem().setTitle('Community').setRequired(true).setChoiceValues(communities);
  items.initiatives = form.addCheckboxItem().setTitle('Initiatives').setChoiceValues(initiatives);
  items.group_chat = form.addMultipleChoiceItem().setTitle('Group Chat').setRequired(true).setChoiceValues([chatYes, chatNo]);
  items.block_watch = form.addMultipleChoiceItem().setTitle('Block Watch').setRequired(true).setChoiceValues([watchYes, watchNo]);
  items.comments = form.addParagraphTextItem().setTitle('Comments');
  items.source = form.addTextItem().setTitle('Source');

  var sheet = SpreadsheetApp.create('DSCA Contact Form Responses');
  form.setDestination(FormApp.DestinationType.SPREADSHEET, sheet.getId());

  // Pre-filled URL reveals each question's entry ID.
  var r = form.createResponse();
  r.withItemResponse(items.first_name.createResponse('x'));
  r.withItemResponse(items.last_name.createResponse('x'));
  r.withItemResponse(items.email.createResponse('x@example.com'));
  r.withItemResponse(items.phone.createResponse('x'));
  r.withItemResponse(items.address.createResponse('x'));
  r.withItemResponse(items.community.createResponse(communities[0]));
  r.withItemResponse(items.initiatives.createResponse([initiatives[0]]));
  r.withItemResponse(items.group_chat.createResponse(chatYes));
  r.withItemResponse(items.block_watch.createResponse(watchYes));
  r.withItemResponse(items.comments.createResponse('x'));
  r.withItemResponse(items.source.createResponse('x'));
  var ids = (r.toPrefilledUrl().match(/entry\.\d+/g) || []);
  var keys = ['first_name', 'last_name', 'email', 'phone', 'address', 'community', 'initiatives', 'group_chat', 'block_watch', 'comments', 'source'];
  var fields = {};
  keys.forEach(function (k, i) { fields[k] = ids[i] || ''; });

  PropertiesService.getScriptProperties().setProperty('FORM_ID', form.getId());
  installTrigger_(form);

  Logger.log('DSCA_CONFIG ' + JSON.stringify({
    contact_form_action: form.getPublishedUrl().replace(/\/viewform.*$/, '/formResponse'),
    contact_form_fields: fields,
    edit_url: form.getEditUrl(),
    sheet_url: sheet.getUrl()
  }));
}

function installTrigger_(form) {
  ScriptApp.getProjectTriggers().forEach(function (t) {
    if (t.getHandlerFunction() === 'onDscaFormSubmit') ScriptApp.deleteTrigger(t);
  });
  ScriptApp.newTrigger('onDscaFormSubmit').forForm(form).onFormSubmit().create();
}

/** Runs automatically on every form submission. */
function onDscaFormSubmit(e) {
  var a = {};
  e.response.getItemResponses().forEach(function (ir) { a[ir.getItem().getTitle()] = ir.getResponse(); });
  addToSender_(a);
}

function senderFetch_(token, path, options) {
  options = options || {};
  options.headers = { Authorization: 'Bearer ' + token, Accept: 'application/json' };
  options.muteHttpExceptions = true;
  return UrlFetchApp.fetch('https://api.sender.net/v2' + path, options);
}

function senderToken_() {
  var token = PropertiesService.getScriptProperties().getProperty('SENDER_TOKEN');
  if (!token) throw new Error('SENDER_TOKEN is not set (Project Settings > Script Properties).');
  return token.trim();
}

function senderGroupId_(token) {
  var props = PropertiesService.getScriptProperties();
  var cached = props.getProperty('SENDER_GROUP_ID');
  if (cached) return cached;
  var res = senderFetch_(token, '/groups?limit=100');
  var list = (JSON.parse(res.getContentText()).data) || [];
  for (var i = 0; i < list.length; i++) {
    if (list[i].title === SENDER_GROUP_NAME) { props.setProperty('SENDER_GROUP_ID', list[i].id); return list[i].id; }
  }
  return null;
}

function addToSender_(a) {
  var token = senderToken_();
  var payload = {
    email: String(a['Email'] || '').trim(),
    firstname: a['First name'] || '',
    lastname: a['Last name'] || ''
  };
  var groupId = senderGroupId_(token);
  if (groupId) payload.groups = [groupId];
  var digits = String(a['Phone'] || '').replace(/\D/g, '');
  if (digits.length === 10) payload.phone = '+1' + digits;
  else if (digits.length === 11 && digits.charAt(0) === '1') payload.phone = '+' + digits;
  var res = senderFetch_(token, '/subscribers', {
    method: 'post', contentType: 'application/json', payload: JSON.stringify(payload)
  });
  Logger.log('Sender ' + res.getResponseCode() + ' ' + res.getContentText().slice(0, 300));
  if (res.getResponseCode() >= 300) {
    throw new Error('Sender did not accept ' + payload.email + ' (' + res.getResponseCode() + '): ' + res.getContentText().slice(0, 300));
  }
}

/** Run this after saving SENDER_TOKEN to confirm the connection. */
function testSenderConnection() {
  var token = senderToken_();
  var res = senderFetch_(token, '/groups?limit=100');
  Logger.log('Sender status ' + res.getResponseCode());
  var list = (JSON.parse(res.getContentText()).data) || [];
  Logger.log('Groups: ' + list.map(function (g) { return g.title; }).join(', '));
  Logger.log('Website group found: ' + (senderGroupId_(token) ? 'yes' : 'NO — create a group named "' + SENDER_GROUP_NAME + '"'));
}

/** Logs the website settings again for an existing form (safe to re-run). */
function showDscaConfig() {
  var form = FormApp.openById(PropertiesService.getScriptProperties().getProperty('FORM_ID'));
  var r = form.createResponse();
  var titles = [];
  form.getItems().forEach(function (it) {
    var t = it.getType(), item;
    if (t === FormApp.ItemType.TEXT) { item = it.asTextItem(); r.withItemResponse(item.createResponse(it.getTitle() === 'Email' ? 'x@example.com' : 'x')); }
    else if (t === FormApp.ItemType.PARAGRAPH_TEXT) { item = it.asParagraphTextItem(); r.withItemResponse(item.createResponse('x')); }
    else if (t === FormApp.ItemType.LIST) { item = it.asListItem(); r.withItemResponse(item.createResponse(item.getChoices()[0].getValue())); }
    else if (t === FormApp.ItemType.CHECKBOX) { item = it.asCheckboxItem(); r.withItemResponse(item.createResponse([item.getChoices()[0].getValue()])); }
    else if (t === FormApp.ItemType.MULTIPLE_CHOICE) { item = it.asMultipleChoiceItem(); r.withItemResponse(item.createResponse(item.getChoices()[0].getValue())); }
    else return;
    titles.push(it.getTitle());
  });
  var ids = r.toPrefilledUrl().match(/entry\.\d+/g) || [];
  var map = {};
  titles.forEach(function (t, i) { map[t] = ids[i]; });
  var sheetId = form.getDestinationId();
  Logger.log('DSCA_CONFIG ' + JSON.stringify({
    contact_form_action: form.getPublishedUrl().replace(/\/viewform.*$/, '/formResponse'),
    by_title: map,
    triggers: ScriptApp.getProjectTriggers().map(function (t) { return t.getHandlerFunction(); }),
    sheet_url: sheetId ? SpreadsheetApp.openById(sheetId).getUrl() : null
  }));
}

/**
 * One-time import of the existing Squarespace sign-ups (Website Submissions >
 * Raw_Data) into Sender. Skips invalid emails, duplicates and test entries,
 * and does NOT trigger automations (so no welcome email goes to existing people).
 */
var IMPORT_SHEET_ID = '1OR66QbnmUcNojCybRgWJe039ps8ZSM3uX5gYs2DrXvs';
var IMPORT_SKIP = ['godaron9+3@gmail.com'];

function importExistingContacts() {
  var token = senderToken_();
  var groupId = senderGroupId_(token);
  if (!groupId) throw new Error('Sender group "' + SENDER_GROUP_NAME + '" not found.');
  var rows = SpreadsheetApp.openById(IMPORT_SHEET_ID).getSheetByName('Raw_Data').getDataRange().getDisplayValues();
  var head = rows.shift().map(function (h) { return String(h).trim(); });
  var col = function (name) { return head.indexOf(name); };
  var cName = col('Name'), cEmail = col('Email'), cPhone = col('Phone');
  var seen = {}, added = 0, skipped = [], failed = [];
  rows.forEach(function (r) {
    var email = String(r[cEmail] || '').trim().toLowerCase();
    if (!/^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(email)) { if (String(r[cName]).trim()) skipped.push(r[cName] + ' (no valid email)'); return; }
    if (seen[email] || IMPORT_SKIP.indexOf(email) >= 0) return;
    seen[email] = true;
    var parts = String(r[cName] || '').trim().split(/\s+/);
    var payload = { email: email, firstname: parts.shift() || '', lastname: parts.join(' '), groups: [groupId], trigger_automation: false };
    var digits = String(r[cPhone] || '').replace(/\D/g, '');
    if (digits.length === 10) payload.phone = '+1' + digits;
    var res = senderFetch_(token, '/subscribers', { method: 'post', contentType: 'application/json', payload: JSON.stringify(payload) });
    if (res.getResponseCode() < 300) added++;
    else failed.push(email + ' (' + res.getResponseCode() + ': ' + res.getContentText().slice(0, 120) + ')');
    Utilities.sleep(250);
  });
  Logger.log('IMPORT added=' + added + ' failed=' + failed.length + ' skipped=' + skipped.length);
  if (skipped.length) Logger.log('Skipped: ' + skipped.join('; '));
  if (failed.length) Logger.log('Failed: ' + failed.join('; '));
}
