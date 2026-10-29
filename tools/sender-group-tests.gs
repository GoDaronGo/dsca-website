/**
 * Sender behavior tests (temporary). Uses senderFetch_/senderToken_/senderGroupId_
 * from the main script. Test subscriber only; never touches real contacts.
 *
 * Order:
 *   1. testA_setup()        creates the "Updated Submission" group + test subscriber
 *   2. testB_assignment()   does a PATCH with groups append or replace?
 *   (Daron builds + activates the test automation on "Updated Submission", Repeat on)
 *   3. testC_rejoin()       remove + re-add with automation on; run twice, a few minutes apart
 *   4. testD_cleanup()      removes the test subscriber
 */
var TEST_EMAIL = 'godaron9+dscatest@gmail.com';
var UPDATED_GROUP_NAME = 'Updated Submission';

function updatedGroupId_(token) {
  var props = PropertiesService.getScriptProperties();
  var cached = props.getProperty('UPDATED_GROUP_ID');
  if (cached) return cached;
  var list = JSON.parse(senderFetch_(token, '/groups?limit=100').getContentText()).data || [];
  for (var i = 0; i < list.length; i++) {
    if (list[i].title === UPDATED_GROUP_NAME) { props.setProperty('UPDATED_GROUP_ID', list[i].id); return list[i].id; }
  }
  return null;
}

function json_(token, method, path, body) {
  var opt = { method: method };
  if (body) { opt.contentType = 'application/json'; opt.payload = JSON.stringify(body); }
  var res = senderFetch_(token, path, opt);
  var txt = res.getContentText();
  Logger.log(method.toUpperCase() + ' ' + path + ' -> ' + res.getResponseCode() + ' ' + txt.slice(0, 400));
  try { return JSON.parse(txt); } catch (e) { return {}; }
}

function testGroups_(token) {
  var d = json_(token, 'get', '/subscribers/' + encodeURIComponent(TEST_EMAIL)).data || {};
  var tags = (d.subscriber_tags || []).map(function (t) { return t.title + ' (' + t.id + ')'; });
  Logger.log('TEST GROUPS NOW: ' + (tags.join(', ') || '(none)'));
  return d.subscriber_tags || [];
}

function testA_setup() {
  var token = senderToken_();
  var gid = updatedGroupId_(token);
  if (!gid) {
    gid = json_(token, 'post', '/groups', { title: UPDATED_GROUP_NAME }).data.id;
    PropertiesService.getScriptProperties().setProperty('UPDATED_GROUP_ID', gid);
  }
  Logger.log('Updated Submission group id: ' + gid);
  json_(token, 'post', '/subscribers', {
    email: TEST_EMAIL, firstname: 'Test', lastname: 'Neighbor',
    groups: [senderGroupId_(token)], trigger_automation: false
  });
  testGroups_(token);
}

/** Answers: does PATCH .../subscribers/{email} with groups REPLACE existing groups or ADD to them? */
function testB_assignment() {
  var token = senderToken_();
  var signups = senderGroupId_(token), upd = updatedGroupId_(token);
  json_(token, 'patch', '/subscribers/' + encodeURIComponent(TEST_EMAIL), {
    groups: [upd], fields: {}, trigger_automation: false
  });
  var tags = testGroups_(token).map(function (t) { return t.id; });
  Logger.log('RESULT B: PATCH groups ' + (tags.indexOf(signups) >= 0 ? 'ADDS (Website Sign-ups kept)' : 'REPLACES (Website Sign-ups dropped)'));
  // Reset: back in Website Sign-ups only, no automations.
  json_(token, 'post', '/subscribers/groups/' + signups, { subscribers: [TEST_EMAIL], trigger_automation: false });
  json_(token, 'delete', '/subscribers/groups/' + upd, { subscribers: [TEST_EMAIL], trigger_automation: false });
  testGroups_(token);
}

/** Remove then re-add to Updated Submission with automations on. Run twice; expect two emails at TEST_EMAIL. */
function testC_rejoin() {
  var token = senderToken_();
  var upd = updatedGroupId_(token);
  json_(token, 'delete', '/subscribers/groups/' + upd, { subscribers: [TEST_EMAIL], trigger_automation: false });
  json_(token, 'post', '/subscribers/groups/' + upd, { subscribers: [TEST_EMAIL], trigger_automation: true });
  testGroups_(token);
  Logger.log('RESULT C: rejoin sent at ' + new Date().toISOString() + ' - check ' + TEST_EMAIL + ' inbox');
}

function testD_cleanup() {
  var token = senderToken_();
  json_(token, 'delete', '/subscribers', { subscribers: [TEST_EMAIL] });
}
