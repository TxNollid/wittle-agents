import {test} from 'node:test';
import assert from 'node:assert/strict';
import {formatConciergeMessage as format} from './concierge-message.mjs';
test('renders the actual demo reply with one role label and a readable scope',()=>{
 const input='Host: Host: I can help.\nScope draft: {"site_url":"https://wittlelabs.ai","goal":"improve wittlelabs.ai"}\nPlease supply the missing scope fields.';
 assert.equal(format(input),'Host: I can help.\nScope so far:\nWebsite: https://wittlelabs.ai\nGoal: improve wittlelabs.ai\nPlease supply the missing scope fields.');
});
test('preserves full scope values, explicit empty lists and confirmation text',()=>{
 const brief={site_url:'https://example.com',pages:['https://example.com/a','https://example.com/b'],excluded_pages:[],goal:'Increase bookings',constraints:['Keep existing branding'],scope_summary:'Review two public pages',findings_cap:5};
 const input=`Host: Review this scope.\nScope draft: ${JSON.stringify(brief)}\nConfirm this exact scope.`;
 const result=format(input);
 for(const value of ['  - https://example.com/a','  - https://example.com/b','Excluded pages: None','  - Keep existing branding','Maximum findings: 5','Confirm this exact scope.'])assert.ok(result.includes(value));
 assert.equal(format(result),result);
 assert.equal(format('Auditor: Ready.'),'Auditor: Ready.');
});
