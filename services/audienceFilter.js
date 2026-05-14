/**
 * audienceFilter.js — single source of truth for "audience" Mongo filters.
 *
 * Legacy-tolerant: when the caller asks for "consumer", we also match documents
 * that pre-date the audience field (missing field = consumer by default).
 * Mongo's { $in: ['consumer', null] } matches docs where audience is 'consumer',
 * is null, or where the field doesn't exist at all.
 *
 *   filter.audience = audienceMatch('consumer'); // { $in: ['consumer', null] }
 *   filter.audience = audienceMatch('business'); // 'business'
 *   audienceMatch(null) === null   // no-op — caller should skip applying it
 */
function audienceMatch(audience) {
  if (audience === 'consumer') return { $in: ['consumer', null] };
  if (audience === 'business') return 'business';
  return null;
}

module.exports = { audienceMatch };
