const test=require('node:test'),assert=require('node:assert/strict');
const {readServiceConfig}=require('../server-runtime-config');
test('unconfigured services have no embedded credentials or owner bypass',()=>{const c=readServiceConfig({});assert.equal(c.GIPHY_KEY,'');assert.equal(c.YOUTUBE_API_KEY,'');assert.equal(c.OWNER_IPS.size,0);});
test('service credentials and owner addresses come exclusively from the supplied environment',()=>{const c=readServiceConfig({GIPHY_KEY:' example-test-key ',YOUTUBE_API_KEY:' example-test-video-key ',OWNER_IPS:'192.0.2.10, 2001:db8::1'});assert.equal(c.GIPHY_KEY,'example-test-key');assert.equal(c.YOUTUBE_API_KEY,'example-test-video-key');assert.deepEqual([...c.OWNER_IPS],['192.0.2.10','2001:db8::1']);});
test('owner allowlist rejects wildcards and malformed addresses',()=>{for(const value of ['*','192.0.2.10/24','not-an-ip'])assert.throws(()=>readServiceConfig({OWNER_IPS:value}),/OWNER_IPS/);});
