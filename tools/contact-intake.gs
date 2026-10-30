/**
 * DSCA website contact intake (replaces the Google Form path).
 *
 * The website POSTs JSON straight to this script's web app (doPost). Each submission:
 *   1. is written first to the "Website Submissions (raw)" tab (nothing is lost if a later step fails),
 *   2. is merged into "All Contacts" (one row per email; blanks never overwrite; Initiatives replace;
 *      Comments keep a dated history, newest first; Updates counts resubmissions),
 *   3. returns {ok, status: "new" | "updated"} so the page shows the right message.
 * A one-minute trigger (processQueue) then does the slow parts for each raw row:
 *   - Sender: new person -> create in "Website Sign-ups" (fires the Welcome automation);
 *     existing person -> update fields WITHOUT touching groups (Sender replaces groups on update),
 *     then leave + rejoin "Updated Submission" with 5 s pauses (fires the update automation).
 *   - Email to NOTIFY_EMAIL with everything on file, what changed, the update number, and a
 *     contact card when they asked for WhatsApp.
 *
 * Uses senderFetch_, senderToken_, senderGroupId_, NOTIFY_EMAIL from Code.gs.
 * One-time setup: setupContactIntake(), then rebuildAllContacts(), then deploy as a web app
 * (Execute as: me, Who has access: Anyone).
 */
var TZ = 'America/Los_Angeles';
var CONTACTS_TAB = 'All Contacts';
var RAW_TAB = 'Website Submissions (raw)';
var FORM_TAB = 'Form Responses 1';
var IMPORTED_TAB = 'Imported (old website)';
var UPDATED_GROUP = 'Updated Submission';
var SENDER_PAUSE_MS = 5000; // Sender needs a few seconds to register a group change.
var REPORT_EMAIL = 'info@deltashorescommunity.com';

var CONTACT_COLS = ['First submitted', 'Last updated', 'First name', 'Last name', 'Email', 'Phone',
  'Street address', 'Community', 'Initiatives', 'Group Chat', 'Block Watch', 'Comments', 'Source', 'Updates', 'Note'];
var RAW_COLS = ['Received', 'Email', 'Result', 'Update #', 'Submission', 'Changes',
  'Sender synced', 'Daron notified', 'Attempts', 'Notes'];

// Submission key -> All Contacts column, for the simple "newest non-blank value wins" fields.
var SIMPLE_FIELDS = [['first_name', 'First name'], ['last_name', 'Last name'], ['phone', 'Phone'],
  ['address', 'Street address'], ['community', 'Community'], ['group_chat', 'Group Chat'], ['block_watch', 'Block Watch']];

// Sender custom fields (title -> how to read it from a contact record).
var SENDER_FIELD_DEFS = [
  ['Phone on file', function (r) { return r['Phone']; }], // Sender's built-in phone does not fill {{ phone }} in emails
  ['Street address', function (r) { return r['Street address']; }],
  ['Community', function (r) { return r['Community']; }],
  ['Initiatives', function (r) { return r['Initiatives']; }],
  ['Group chat', function (r) { return yesNo_(r['Group Chat']); }],
  ['Block watch', function (r) { return yesNo_(r['Block Watch']); }],
  ['Latest comment', function (r) { return latestComment_(r['Comments']); }],
  ['Last updated', function (r) { return r['Last updated'] ? fmtLong_(r['Last updated']) : ''; }]
];

/* ------------------------------------------------------------------ web app */

function doGet() { return json_out_({ ok: true, service: 'dsca-contact' }); }

function doPost(e) {
  var sub;
  try { sub = JSON.parse((e && e.postData && e.postData.contents) || '{}'); }
  catch (err) { return json_out_({ ok: false, error: 'bad_request' }); }
  if (String(sub.website || '').trim()) return json_out_({ ok: true, status: 'new' }); // honeypot: drop bots quietly
  var problem = validate_(sub);
  if (problem) return json_out_({ ok: false, error: problem });
  try {
    var res = intake_(sub, new Date());
    return json_out_({ ok: true, status: res.status });
  } catch (err) {
    try { MailApp.sendEmail(NOTIFY_EMAIL, 'DSCA website form error', 'A submission from ' + sub.email + ' hit an error: ' + err + '\n\nIt is saved in the "' + RAW_TAB + '" tab if that step ran.'); } catch (e2) {}
    return json_out_({ ok: false, error: 'server' });
  }
}

/** Old Google Form path (kept so a stale page or the Form link still lands in the same pipeline). */
function onDscaFormSubmit(e) {
  var a = {};
  e.response.getItemResponses().forEach(function (ir) { a[ir.getItem().getTitle()] = ir.getResponse(); });
  var sub = {
    first_name: a['First name'], last_name: a['Last name'], email: a['Email'], phone: a['Phone'],
    address: a['Street address'], community: a['Community'], initiatives: a['Initiatives'] || [],
    group_chat: a['Group Chat'], block_watch: a['Block Watch'], comments: a['Comments'], source: a['Source'] || 'google-form'
  };
  if (!validate_(sub)) intake_(sub, e.response.getTimestamp() || new Date());
}

function validate_(s) {
  if (!clean_(s.first_name) || !clean_(s.last_name)) return 'name';
  if (!/^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(clean_(s.email))) return 'email';
  if (!clean_(s.community) || !clean_(s.group_chat) || !clean_(s.block_watch)) return 'required';
  return '';
}

function json_out_(o) { return ContentService.createTextOutput(JSON.stringify(o)).setMimeType(ContentService.MimeType.JSON); }

/* ------------------------------------------------------------------ intake */

function intake_(sub, when) {
  var lock = LockService.getScriptLock();
  lock.waitLock(25000);
  try {
    var ss = sheet_();
    var raw = rawTab_(ss);
    raw.appendRow([when, clean_(sub.email).toLowerCase(), '', '', JSON.stringify(sub), '', '', '', 0, '']);
    var rawRow = raw.getLastRow();
    var res = upsertContact_(ss, sub, when);
    raw.getRange(rawRow, 3, 1, 4).setValues([[res.status, res.updates, JSON.stringify(sub), JSON.stringify(res.changes)]]);
    return res;
  } finally {
    lock.releaseLock();
  }
}

/** Finds the person by email in All Contacts, merges, writes the row. Caller holds the lock. */
function upsertContact_(ss, sub, when) {
  var sh = contactsTab_(ss);
  var email = clean_(sub.email).toLowerCase();
  var last = sh.getLastRow();
  var emails = last > 1 ? sh.getRange(2, col_('Email'), last - 1, 1).getValues() : [];
  var row = -1;
  for (var i = 0; i < emails.length; i++) { if (String(emails[i][0]).trim().toLowerCase() === email) { row = i + 2; break; } }

  var rec, status, changes;
  if (row < 0) {
    rec = blankRecord_();
    rec['First submitted'] = when; rec['Email'] = email; rec['Source'] = clean_(sub.source) || 'website'; rec['Updates'] = 0;
    applySubmission_(rec, sub, when);
    changes = [];
    status = 'new';
    sh.appendRow(toRow_(rec));
    row = sh.getLastRow();
  } else {
    rec = fromRow_(sh.getRange(row, 1, 1, CONTACT_COLS.length).getValues()[0]);
    changes = applySubmission_(rec, sub, when);
    rec['Updates'] = (Number(rec['Updates']) || 0) + 1;
    status = 'updated';
    sh.getRange(row, 1, 1, CONTACT_COLS.length).setValues([toRow_(rec)]);
  }
  sh.getRange(row, 1, 1, 2).setNumberFormat('m/d/yyyy h:mm am/pm');
  return { status: status, updates: rec['Updates'], changes: changes, record: rec };
}

/** Merge rules. Returns [{field, from, to}] for what changed. */
function applySubmission_(rec, sub, when) {
  var changes = [];
  SIMPLE_FIELDS.forEach(function (f) {
    var v = f[0] === 'phone' ? normPhone_(sub[f[0]]) : clean_(sub[f[0]]);
    if (!v) return; // blanks never overwrite
    var cur = f[0] === 'phone' ? normPhone_(rec[f[1]]) : clean_(rec[f[1]]);
    if (v !== cur) { changes.push({ field: f[1], from: cur, to: v }); }
    rec[f[1]] = v;
  });
  var ini = sub.initiatives;
  ini = (Array.isArray(ini) ? ini : String(ini || '').split(/\s*,\s*/)).map(clean_).filter(String).join(', ');
  if (ini && ini !== clean_(rec['Initiatives'])) { changes.push({ field: 'Initiatives', from: clean_(rec['Initiatives']), to: ini }); rec['Initiatives'] = ini; }
  var c = clean_(sub.comments);
  if (c) {
    rec['Comments'] = '[' + fmtShort_(when) + '] ' + c + (clean_(rec['Comments']) ? '\n' + rec['Comments'] : '');
    changes.push({ field: 'Comments', from: '', to: c, added: true });
  }
  rec['Last updated'] = when;
  return changes;
}

/* ------------------------------------------------------------------ queue */

/** Runs every minute: Sender sync + Daron's email for each processed raw row. */
function processQueue() {
  var props = PropertiesService.getScriptProperties();
  var busy = Number(props.getProperty('QUEUE_BUSY') || 0);
  if (busy && Date.now() - busy < 5 * 60 * 1000) return;
  props.setProperty('QUEUE_BUSY', String(Date.now()));
  try {
    var ss = sheet_();
    var raw = rawTab_(ss);
    var n = raw.getLastRow() - 1;
    if (n < 1) return;
    var rows = raw.getRange(2, 1, n, RAW_COLS.length).getValues();
    var done = 0;
    for (var i = 0; i < rows.length && done < 5; i++) {
      var r = rows[i], status = r[2];
      if (status !== 'new' && status !== 'updated') continue;
      if (r[6] && r[7]) continue;
      if (Number(r[8]) >= 3) continue;
      done++;
      var rowNum = i + 2, notes = [];
      var rec = findContact_(ss, r[1]);
      if (!rec) { raw.getRange(rowNum, 9, 1, 2).setValues([[3, 'Contact row not found for ' + r[1]]]); continue; }
      var changes = []; try { changes = JSON.parse(r[5] || '[]'); } catch (e) {}
      if (!r[6]) {
        try { syncSender_(rec, status); raw.getRange(rowNum, 7).setValue(new Date()); }
        catch (err) { notes.push('Sender: ' + err); }
      }
      if (!r[7]) {
        try { notifyDaron_(rec, status, Number(r[3]) || 0, changes); raw.getRange(rowNum, 8).setValue(new Date()); }
        catch (err) { notes.push('Email: ' + err); }
      }
      if (notes.length) {
        var attempts = (Number(r[8]) || 0) + 1;
        raw.getRange(rowNum, 9, 1, 2).setValues([[attempts, notes.join(' | ')]]);
        if (attempts >= 3) MailApp.sendEmail(NOTIFY_EMAIL, 'DSCA website: could not finish processing ' + r[1], notes.join('\n') + '\n\nRow ' + rowNum + ' of "' + RAW_TAB + '". Clear the Attempts cell to retry.');
      }
    }
  } finally {
    props.deleteProperty('QUEUE_BUSY');
  }
}

function findContact_(ss, email) {
  var sh = contactsTab_(ss);
  var last = sh.getLastRow();
  if (last < 2) return null;
  var vals = sh.getRange(2, 1, last - 1, CONTACT_COLS.length).getValues();
  var e = String(email).trim().toLowerCase();
  for (var i = 0; i < vals.length; i++) if (String(vals[i][col_('Email') - 1]).trim().toLowerCase() === e) return fromRow_(vals[i]);
  return null;
}

/* ------------------------------------------------------------------ Sender */

function sjson_(token, method, path, body) {
  var opt = { method: method };
  if (body) { opt.contentType = 'application/json'; opt.payload = JSON.stringify(body); }
  var res = senderFetch_(token, path, opt);
  var out = {}; try { out = JSON.parse(res.getContentText()); } catch (e) {}
  out._code = res.getResponseCode();
  out._text = res.getContentText().slice(0, 300);
  return out;
}

function syncSender_(rec, status) {
  var token = senderToken_();
  var email = rec['Email'];
  var base = { firstname: rec['First name'], lastname: rec['Last name'], fields: senderFieldValues_(rec) };
  var phone = e164_(rec['Phone']);
  if (phone) base.phone = phone;

  if (status === 'new') {
    var c = sjson_(token, 'post', '/subscribers', merge_(base, { email: email, groups: [senderGroupId_(token)], trigger_automation: true }));
    if (c._code < 300) return;
    // Already in Sender (e.g. added another way): update them and fall through to the update email.
    Logger.log('Sender create returned ' + c._code + ' for ' + email + '; treating as update. ' + c._text);
  }
  var p = sjson_(token, 'patch', '/subscribers/' + encodeURIComponent(email), merge_(base, { trigger_automation: false }));
  if (p._code === 404) {
    var c2 = sjson_(token, 'post', '/subscribers', merge_(base, { email: email, groups: [senderGroupId_(token)], trigger_automation: false }));
    if (c2._code >= 300) throw new Error('create ' + c2._code + ' ' + c2._text);
  } else if (p._code >= 300) {
    throw new Error('update ' + p._code + ' ' + p._text);
  }
  var gid = updGroupId_(token);
  Utilities.sleep(SENDER_PAUSE_MS);
  sjson_(token, 'delete', '/subscribers/groups/' + gid, { subscribers: [email], trigger_automation: false });
  Utilities.sleep(SENDER_PAUSE_MS);
  var add = sjson_(token, 'post', '/subscribers/groups/' + gid, { subscribers: [email], trigger_automation: true });
  var added = add.message && add.message.subscribers_add_tag_group || [];
  if (added.indexOf(email) < 0) throw new Error('rejoin to ' + UPDATED_GROUP + ' did not register: ' + add._text);
}

function updGroupId_(token) {
  var props = PropertiesService.getScriptProperties();
  var id = props.getProperty('UPDATED_GROUP_ID');
  if (id) return id;
  var list = sjson_(token, 'get', '/groups?limit=100').data || [];
  for (var i = 0; i < list.length; i++) if (list[i].title === UPDATED_GROUP) { props.setProperty('UPDATED_GROUP_ID', list[i].id); return list[i].id; }
  throw new Error('Sender group "' + UPDATED_GROUP + '" not found');
}

function senderFieldValues_(rec) {
  var map = JSON.parse(PropertiesService.getScriptProperties().getProperty('SENDER_FIELDS') || '{}');
  var out = {};
  SENDER_FIELD_DEFS.forEach(function (d) { if (map[d[0]]) out[map[d[0]]] = String(d[1](rec) || ''); });
  return out;
}

/** Creates any missing Sender custom fields and stores title -> merge tag in SENDER_FIELDS. Safe to re-run. */
function setupSenderFields() {
  var token = senderToken_();
  var list = sjson_(token, 'get', '/fields?limit=100');
  Logger.log('Existing fields: ' + list._text);
  var have = {};
  (list.data || []).forEach(function (f) { have[f.title] = f.field_name || f.name || f.tag; });
  var map = {};
  SENDER_FIELD_DEFS.forEach(function (d) {
    var title = d[0];
    if (!have[title]) {
      var c = sjson_(token, 'post', '/fields', { title: title, type: 'text' });
      Logger.log('Create field ' + title + ' -> ' + c._code + ' ' + c._text);
      have[title] = (c.data && (c.data.field_name || c.data.name)) || c.field_name;
    }
    map[title] = have[title];
  });
  PropertiesService.getScriptProperties().setProperty('SENDER_FIELDS', JSON.stringify(map));
  Logger.log('SENDER_FIELDS ' + JSON.stringify(map));
}

/* ------------------------------------------------------------------ Daron's email */

function notifyDaron_(rec, status, updates, changes) {
  var name = (rec['First name'] + ' ' + rec['Last name']).trim();
  var wantsChat = /^yes/i.test(String(rec['Group Chat']));
  var subject = (status === 'new' ? 'New sign-up: ' + name : 'Updated: ' + name + ' (' + ordinal_(updates) + ' update)') + (wantsChat ? ' · WhatsApp' : '');
  var changed = {};
  changes.forEach(function (c) { changed[c.field] = c; });

  var esc = function (s) { return String(s == null ? '' : s).replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;'); };
  var lines = [], html = [];
  html.push('<div style="font-family:Arial,Helvetica,sans-serif;color:#142640;font-size:15px;line-height:1.5;max-width:640px">');
  if (status === 'new') {
    html.push('<p style="margin:0 0 12px"><strong>New website sign-up.</strong> Sender is sending them the Welcome email.</p>');
    lines.push('New website sign-up. Sender is sending them the Welcome email.', '');
  } else {
    html.push('<p style="margin:0 0 12px"><strong>This is the ' + ordinal_(updates) + ' update for this record.</strong> Sender is sending them the update email.</p>');
    lines.push('This is the ' + ordinal_(updates) + ' update for this record. Sender is sending them the update email.', '');
    if (changes.length) {
      html.push('<p style="margin:0 0 6px"><strong>What changed:</strong></p><ul style="margin:0 0 14px;padding-left:20px">');
      lines.push('What changed:');
      changes.forEach(function (c) {
        var t = c.added ? 'New comment: ' + c.to : c.field + ': ' + (c.from || '(blank)') + ' → ' + c.to;
        html.push('<li>' + esc(t) + '</li>'); lines.push('- ' + t);
      });
      html.push('</ul>'); lines.push('');
    } else {
      html.push('<p style="margin:0 0 14px">Nothing changed: they resubmitted the same information.</p>');
      lines.push('Nothing changed: they resubmitted the same information.', '');
    }
  }
  if (wantsChat) {
    html.push('<p style="margin:0 0 14px;background:#e8f3ec;border-left:4px solid #1d6b44;padding:8px 12px">Wants the WhatsApp group. The contact card is attached.</p>');
    lines.push('Wants the WhatsApp group. The contact card is attached.', '');
  }
  var show = [['Name', name, changed['First name'] || changed['Last name']], ['Email', rec['Email']], ['Phone', rec['Phone'], changed['Phone']],
    ['Street address', rec['Street address'], changed['Street address']], ['Community', rec['Community'], changed['Community']],
    ['Initiatives', rec['Initiatives'], changed['Initiatives']], ['Group chat', rec['Group Chat'], changed['Group Chat']],
    ['Block Watch', rec['Block Watch'], changed['Block Watch']], ['Latest comment', latestComment_(rec['Comments']), changed['Comments']],
    ['First submitted', rec['First submitted'] ? fmtLong_(rec['First submitted']) : ''], ['Last updated', rec['Last updated'] ? fmtLong_(rec['Last updated']) : ''],
    ['Updates so far', String(rec['Updates'] || 0)], ['Source', rec['Source']]];
  html.push('<table cellpadding="6" cellspacing="0" style="border-collapse:collapse;width:100%;font-size:14px">');
  lines.push('On file:');
  show.forEach(function (s) {
    var bg = s[2] ? 'background:#fdf6e1;' : '';
    html.push('<tr style="border-top:1px solid #d5dde9;' + bg + '"><td style="width:150px;color:#475569;vertical-align:top">' + esc(s[0]) + (s[2] ? ' <span style="color:#a16207">(changed)</span>' : '') + '</td><td>' + (esc(s[1]) || '<span style="color:#94a3b8">(not given)</span>') + '</td></tr>');
    lines.push(s[0] + ': ' + (s[1] || '(not given)') + (s[2] ? '  (changed)' : ''));
  });
  html.push('</table>');
  var url = sheet_().getUrl();
  html.push('<p style="margin:14px 0 0;font-size:13px"><a href="' + url + '">Open the contact sheet</a></p></div>');
  lines.push('', 'Contact sheet: ' + url);

  var msg = { to: NOTIFY_EMAIL, subject: subject, body: lines.join('\n'), htmlBody: html.join(''), name: 'DSCA Website' };
  if (wantsChat) msg.attachments = [vcard_(rec)];
  MailApp.sendEmail(msg);
}

function vcard_(rec) {
  var first = rec['First name'], last = rec['Last name'], name = (first + ' ' + last).trim();
  var esc = function (s) { return String(s || '').replace(/([\\;,])/g, '\\$1'); };
  var vcf = ['BEGIN:VCARD', 'VERSION:3.0', 'N:' + esc(last) + ';' + esc(first) + ';;;', 'FN:' + esc(name),
    rec['Phone'] ? 'TEL;TYPE=CELL:' + rec['Phone'] : '', 'EMAIL:' + esc(rec['Email']),
    rec['Street address'] ? 'ADR;TYPE=HOME:;;' + esc(rec['Street address']) + ';;;;' : '',
    'ORG:Delta Shores' + (rec['Community'] ? ' - ' + esc(rec['Community']) : ''), 'END:VCARD'].filter(String).join('\r\n');
  return Utilities.newBlob(vcf, 'text/vcard', (name.replace(/[^\w ]/g, '') || 'contact') + '.vcf');
}

/* ------------------------------------------------------------------ setup + rebuild */

/** One-time: remembers the sheet, creates the raw tab, Sender fields, and the 1-minute queue trigger. Safe to re-run. */
function setupContactIntake() {
  var props = PropertiesService.getScriptProperties();
  if (!props.getProperty('SHEET_ID')) {
    var form = FormApp.openById(props.getProperty('FORM_ID'));
    props.setProperty('SHEET_ID', form.getDestinationId());
  }
  rawTab_(sheet_());
  setupSenderFields();
  ScriptApp.getProjectTriggers().forEach(function (t) { if (t.getHandlerFunction() === 'processQueue') ScriptApp.deleteTrigger(t); });
  ScriptApp.newTrigger('processQueue').timeBased().everyMinutes(1).create();
  Logger.log('SETUP sheet=' + sheet_().getUrl() + ' triggers=' + ScriptApp.getProjectTriggers().map(function (t) { return t.getHandlerFunction(); }).join(','));
}

/**
 * Rebuilds All Contacts as one row per email from every source, oldest first:
 * Imported (old website) + Form Responses 1 + Website Submissions (raw).
 * An identical resubmission within 10 minutes (the double-click problem) is not counted as an update.
 * Replaces the old SORT/VSTACK formula with plain values. Does not touch Sender or send email.
 */
function rebuildAllContacts() {
  var lock = LockService.getScriptLock();
  lock.waitLock(25000);
  try {
    var ss = sheet_();
    var subs = [];
    var readTab = function (name) {
      var sh = ss.getSheetByName(name);
      if (!sh || sh.getLastRow() < 2) return [];
      var v = sh.getDataRange().getValues(), h = v.shift().map(String);
      return v.map(function (r) { var o = {}; h.forEach(function (k, i) { o[k] = r[i]; }); return o; });
    };
    readTab(IMPORTED_TAB).forEach(function (o) {
      subs.push({ when: o['Timestamp'] instanceof Date ? o['Timestamp'] : null, note: o['Import note'] || '', sub: fromSheetRow_(o, 'Old website (Squarespace)') });
    });
    readTab(FORM_TAB).forEach(function (o) {
      if (!o['Timestamp']) return;
      subs.push({ when: o['Timestamp'], sub: fromSheetRow_(o, o['Source'] || 'website') });
    });
    readTab(RAW_TAB).forEach(function (o) {
      if (o['Result'] !== 'new' && o['Result'] !== 'updated') return;
      try { subs.push({ when: o['Received'], sub: JSON.parse(o['Submission']) }); } catch (e) {}
    });
    subs.sort(function (a, b) { return (a.when ? a.when.getTime() : 0) - (b.when ? b.when.getTime() : 0); });

    var people = {}, order = [], skipped = 0;
    subs.forEach(function (s) {
      var email = clean_(s.sub.email).toLowerCase();
      var valid = /^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(email);
      var key = valid ? email : 'name:' + (clean_(s.sub.first_name) + ' ' + clean_(s.sub.last_name)).toLowerCase();
      var when = s.when || new Date(0);
      var p = people[key];
      if (!p) {
        p = blankRecord_();
        p['First submitted'] = s.when || ''; p['Email'] = valid ? email : ''; p['Source'] = clean_(s.sub.source) || 'website';
        p['Updates'] = 0; p['Note'] = s.note || '';
        applySubmission_(p, s.sub, when);
        if (!s.when) p['Last updated'] = '';
        if (!s.when && p['Comments']) p['Comments'] = p['Comments'].replace(/^\[[^\]]*\] /, '');
        people[key] = p; order.push(key);
        return;
      }
      var prevWhen = p['Last updated'] instanceof Date ? p['Last updated'] : null;
      var copy = JSON.parse(JSON.stringify(p));
      var ch = applySubmission_(copy, s.sub, when);
      if (!ch.length && prevWhen && when - prevWhen < 10 * 60 * 1000) { skipped++; return; }
      applySubmission_(p, s.sub, when);
      p['Updates'] = (Number(p['Updates']) || 0) + 1;
    });

    var rows = order.map(function (k) { return toRow_(people[k]); });
    rows.sort(function (a, b) { return (b[1] || b[0] || 0) - (a[1] || a[0] || 0); });
    var sh = ss.getSheetByName(CONTACTS_TAB) || ss.insertSheet(CONTACTS_TAB, 0);
    sh.clear();
    sh.getRange(1, 1, 1, CONTACT_COLS.length).setValues([CONTACT_COLS]).setFontWeight('bold');
    if (rows.length) sh.getRange(2, 1, rows.length, CONTACT_COLS.length).setValues(rows);
    sh.getRange('A:B').setNumberFormat('m/d/yyyy h:mm am/pm');
    sh.getRange(2, col_('Phone'), Math.max(rows.length, 1), 1).setNumberFormat('@');
    sh.getRange(2, col_('Comments'), Math.max(rows.length, 1), 1).setWrap(true);
    sh.setFrozenRows(1);
    Logger.log('REBUILT people=' + rows.length + ' fromSubmissions=' + subs.length + ' skippedDoubleClicks=' + skipped);
  } finally {
    lock.releaseLock();
  }
}

/** Converts a Form Responses / Imported row into the website submission shape. */
function fromSheetRow_(o, source) {
  return {
    first_name: o['First name'], last_name: o['Last name'], email: o['Email'], phone: o['Phone'],
    address: o['Street address'], community: o['Community'], initiatives: String(o['Initiatives'] || ''),
    group_chat: o['Group Chat'], block_watch: o['Block Watch'], comments: o['Comments'], source: source
  };
}

/** Last step of the move off the Google Form: stop it accepting responses. */
function closeGoogleForm() {
  var form = FormApp.openById(PropertiesService.getScriptProperties().getProperty('FORM_ID'));
  form.setAcceptingResponses(false);
  Logger.log('Form ' + form.getTitle() + ' accepting responses: ' + form.isAcceptingResponses());
}

/* ------------------------------------------------------------------ helpers */

function sheet_() { return SpreadsheetApp.openById(PropertiesService.getScriptProperties().getProperty('SHEET_ID')); }

function contactsTab_(ss) {
  var sh = ss.getSheetByName(CONTACTS_TAB);
  if (!sh) throw new Error('No "' + CONTACTS_TAB + '" tab');
  var head = sh.getRange(1, 1, 1, CONTACT_COLS.length).getValues()[0].map(String);
  if (head.join('|') !== CONTACT_COLS.join('|')) throw new Error('"' + CONTACTS_TAB + '" columns are not the expected layout. Run rebuildAllContacts().');
  return sh;
}

function rawTab_(ss) {
  var sh = ss.getSheetByName(RAW_TAB);
  if (!sh) {
    sh = ss.insertSheet(RAW_TAB);
    sh.getRange(1, 1, 1, RAW_COLS.length).setValues([RAW_COLS]).setFontWeight('bold');
    sh.setFrozenRows(1);
    sh.getRange('A:A').setNumberFormat('m/d/yyyy h:mm:ss am/pm');
    sh.getRange('G:H').setNumberFormat('m/d/yyyy h:mm am/pm');
  }
  return sh;
}

function col_(name) { return CONTACT_COLS.indexOf(name) + 1; }
function blankRecord_() { var r = {}; CONTACT_COLS.forEach(function (c) { r[c] = ''; }); return r; }
function toRow_(rec) { return CONTACT_COLS.map(function (c) { return rec[c] === undefined || rec[c] === null ? '' : rec[c]; }); }
function fromRow_(row) { var r = {}; CONTACT_COLS.forEach(function (c, i) { r[c] = row[i]; }); return r; }
function merge_(a, b) { var o = {}; [a, b].forEach(function (x) { Object.keys(x).forEach(function (k) { o[k] = x[k]; }); }); return o; }
function clean_(v) { return v === null || v === undefined ? '' : String(v).replace(/\s+/g, ' ').trim(); }

function normPhone_(v) {
  var s = clean_(v), d = s.replace(/\D/g, '');
  if (d.length === 11 && d.charAt(0) === '1') d = d.slice(1);
  return d.length === 10 ? '(' + d.slice(0, 3) + ') ' + d.slice(3, 6) + '-' + d.slice(6) : s;
}
function e164_(v) { var d = String(v || '').replace(/\D/g, ''); if (d.length === 11 && d.charAt(0) === '1') d = d.slice(1); return d.length === 10 ? '+1' + d : ''; }
function yesNo_(v) { return clean_(v) ? (/^yes/i.test(clean_(v)) ? 'Yes' : 'No') : ''; }
function latestComment_(c) { return clean_(String(c || '').split('\n')[0].replace(/^\[[^\]]*\]\s*/, '')); }
function fmtShort_(d) { return Utilities.formatDate(d, TZ, 'M/d/yyyy h:mm a'); }
function fmtLong_(d) { return d instanceof Date ? Utilities.formatDate(d, TZ, "MMMM d, yyyy 'at' h:mm a") : String(d); }
function ordinal_(n) { var s = ['th', 'st', 'nd', 'rd'], v = n % 100; return n + (s[(v - 20) % 10] || s[v] || s[0]); }
