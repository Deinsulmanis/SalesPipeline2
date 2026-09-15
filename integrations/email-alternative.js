'use strict';

const { randomUUID } = require('node:crypto');

function buildMultipartAlternative(text, html) {
  const boundary = `scalelab-${randomUUID()}`;
  const encode = value => Buffer.from(String(value), 'utf8').toString('base64').match(/.{1,76}/g)?.join('\r\n') || '';
  return {
    contentType: `multipart/alternative; boundary="${boundary}"`,
    body: [
      `--${boundary}`, 'Content-Type: text/plain; charset="UTF-8"', 'Content-Transfer-Encoding: base64', '', encode(text),
      `--${boundary}`, 'Content-Type: text/html; charset="UTF-8"', 'Content-Transfer-Encoding: base64', '', encode(html),
      `--${boundary}--`, '',
    ].join('\r\n'),
  };
}

module.exports = { buildMultipartAlternative };
