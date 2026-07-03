import test from 'node:test';
import assert from 'node:assert/strict';

import { checkMeetAccess } from '../services/accessService.js';
import { detectArchivePublicDomain } from '../services/sourceAdapters/archiveAdapter.js';
import { evaluateArchiveRoomEligibility } from '../services/bookAggregationService.js';

const originalFetch = global.fetch;

test.afterEach(() => {
  global.fetch = originalFetch;
});

test('Gutenberg source books are eligible for Meet without Archive metadata lookup', async () => {
  const access = await checkMeetAccess({ userId: 'user-1', source: 'gutenberg', sourceBookId: '1342' });
  assert.equal(access.access, true);
  assert.equal(access.mode, 'open');
});

test('Archive public-domain books are eligible even when no reader format is available', async () => {
  global.fetch = async () => new Response(JSON.stringify({
    metadata: {
      title: 'Public Archive Book',
      rights: 'Public Domain',
      licenseurl: 'https://creativecommons.org/publicdomain/mark/1.0/',
      access: 'public',
      availability: 'full',
    },
    files: [{ name: 'metadata.xml', format: 'Metadata' }],
  }), { status: 200 });

  const eligibility = await evaluateArchiveRoomEligibility({ source: 'archive', sourceId: 'public-book', timeoutMs: 1000 });
  assert.equal(eligibility.bookFound, true);
  assert.equal(eligibility.metadataLoaded, true);
  assert.equal(eligibility.isPublicDomain, true);
  assert.equal(eligibility.readable, false);
  assert.equal(eligibility.eligible, true);
});

test('Archive lending/restricted books are not eligible without public-domain rights or license', async () => {
  global.fetch = async () => new Response(JSON.stringify({
    metadata: {
      title: 'Restricted Archive Book',
      rights: 'In Copyright',
      access: 'restricted',
      availability: 'borrow',
    },
    files: [{ name: 'restricted.pdf', format: 'Text PDF' }],
  }), { status: 200 });

  const eligibility = await evaluateArchiveRoomEligibility({ source: 'archive', sourceId: 'restricted-book', timeoutMs: 1000 });
  assert.equal(eligibility.bookFound, true);
  assert.equal(eligibility.metadataLoaded, true);
  assert.equal(eligibility.isPublicDomain, false);
  assert.equal(eligibility.eligible, false);
});

test('local canonical book ids remain eligible when they exist', async () => {
  const access = await checkMeetAccess({ userId: 'user-1', source: 'local', sourceBookId: 'local-book-1' });
  assert.equal(access.access, true);
  assert.equal(access.mode, 'open');
});

test('Archive public-domain detection accepts common rights and license shapes', () => {
  assert.equal(detectArchivePublicDomain({ rights: 'Public Domain' }), true);
  assert.equal(detectArchivePublicDomain({ rights: 'No known copyright restrictions' }), true);
  assert.equal(detectArchivePublicDomain({ licenseurl: ['https://creativecommons.org/publicdomain/zero/1.0/'] }), true);
  assert.equal(detectArchivePublicDomain({ rights: 'In Copyright' }), false);
});
