/**
 * One-time setup: creates the DSCA Contact & Involvement Google Form,
 * links it to a new response spreadsheet, and logs the settings the website
 * needs (formResponse URL + entry IDs) for content/site.json.
 * Run createDscaContactForm() once from the Apps Script editor.
 */
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

  // Build a pre-filled URL to read each question's entry ID.
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
  var prefilled = r.toPrefilledUrl();

  var ids = (prefilled.match(/entry\.\d+/g) || []);
  var keys = ['first_name', 'last_name', 'email', 'phone', 'address', 'community', 'initiatives', 'group_chat', 'block_watch', 'comments', 'source'];
  var fields = {};
  keys.forEach(function (k, i) { fields[k] = ids[i] || ''; });

  var out = {
    contact_form_action: form.getPublishedUrl().replace(/\/viewform.*$/, '/formResponse'),
    contact_form_fields: fields,
    edit_url: form.getEditUrl(),
    sheet_url: sheet.getUrl()
  };
  Logger.log('DSCA_CONFIG ' + JSON.stringify(out));
}
