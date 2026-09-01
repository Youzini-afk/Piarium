import fs from 'node:fs';

const HEADER_DELIMITER = Buffer.from('\r\n\r\n');

const extractContentLength = (header) => {
  const match = /Content-Length:\s*(\d+)/i.exec(header.toString('utf8'));
  return match ? Number(match[1]) : null;
};

export const writeContentLengthMessage = (output, message) => {
  const payload = Buffer.from(JSON.stringify(message), 'utf8');
  const frame = Buffer.concat([
    Buffer.from(`Content-Length: ${payload.length}\r\n\r\n`, 'utf8'),
    payload,
  ]);
  if (typeof output.fd === 'number') {
    fs.writeSync(output.fd, frame);
    return;
  }
  output.write(frame);
};

export const attachContentLengthReader = (input, onMessage) => {
  let buffer = Buffer.alloc(0);
  const onData = (chunk) => {
    buffer = Buffer.concat([buffer, chunk]);
    while (true) {
      const headerEnd = buffer.indexOf(HEADER_DELIMITER);
      if (headerEnd === -1) break;
      const length = extractContentLength(buffer.subarray(0, headerEnd));
      if (!Number.isFinite(length) || length < 0) {
        buffer = buffer.subarray(headerEnd + HEADER_DELIMITER.length);
        continue;
      }
      const bodyStart = headerEnd + HEADER_DELIMITER.length;
      if (buffer.length < bodyStart + length) break;
      const body = buffer.subarray(bodyStart, bodyStart + length).toString('utf8');
      buffer = buffer.subarray(bodyStart + length);
      try {
        onMessage(JSON.parse(body));
      } catch {
        // Protocol bodies are private and malformed frames are ignored.
      }
    }
  };
  input.on('data', onData);
  return () => input.off('data', onData);
};
