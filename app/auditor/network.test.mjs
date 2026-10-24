import test from 'node:test';
import assert from 'node:assert/strict';
import { EventEmitter } from 'node:events';
import https from 'node:https';
import { publicFetch } from './network.mjs';

test('a public HTTP redirect to metadata is rejected before a second socket or DNS request', async t => {
  let sockets = 0;
  let resolutions = 0;
  t.mock.method(https, 'get', (_url, options, callback) => {
    sockets++;
    options.lookup('example.com', {}, (error, address) => {
      assert.equal(error, null);
      assert.equal(address, '93.184.216.34');
    });
    const request = new EventEmitter();
    request.setTimeout = () => request;
    queueMicrotask(() => {
      const response = new EventEmitter();
      response.statusCode = 302;
      response.headers = { location: 'http://169.254.169.254/latest/meta-data/' };
      callback(response);
      response.emit('end');
    });
    return request;
  });
  await assert.rejects(publicFetch('https://example.com/', {
    resolve: async () => { resolutions++; return [{ address: '93.184.216.34', family: 4 }]; },
  }), /URL_NOT_PUBLIC/);
  assert.equal(sockets, 1);
  assert.equal(resolutions, 1);
});

test('redirect hops share the physical request budget', async t => {
  let sockets = 0;
  t.mock.method(https, 'get', (_url, _options, callback) => {
    sockets++;
    const request = new EventEmitter();
    request.setTimeout = () => request;
    queueMicrotask(() => {
      const response = new EventEmitter();
      response.statusCode = 302;
      response.headers = { location: 'https://example.com/next' };
      callback(response);
      response.emit('end');
    });
    return request;
  });
  await assert.rejects(publicFetch('https://example.com/', {
    resolve: async () => [{ address: '93.184.216.34', family: 4 }],
    budget: { requests: 0, bytes: 0, maxRequests: 1, maxBytes: 1000 },
  }), /REQUEST_LIMIT/);
  assert.equal(sockets, 1);
});
