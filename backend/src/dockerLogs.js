// Demultiplex a Docker log buffer into {stream, text} frames.
// Non-TTY containers prefix every frame with an 8-byte header:
// [type, 0, 0, 0, size(4 bytes BE)]. TTY containers send raw text.
// Returns any incomplete trailing bytes so streaming callers can
// carry them over to the next chunk.
function demuxDockerStream(buffer) {
  const frames = [];
  let offset = 0;

  while (buffer.length - offset >= 8) {
    const type = buffer[offset];
    const isHeader = type <= 2 &&
      buffer[offset + 1] === 0 &&
      buffer[offset + 2] === 0 &&
      buffer[offset + 3] === 0;

    if (!isHeader) {
      // TTY mode: no multiplexing, the rest of the buffer is raw output
      frames.push({ stream: 'stdout', text: buffer.toString('utf8', offset) });
      return { frames, rest: Buffer.alloc(0) };
    }

    const size = buffer.readUInt32BE(offset + 4);
    if (buffer.length - offset - 8 < size) break; // incomplete frame

    frames.push({
      stream: type === 2 ? 'stderr' : 'stdout',
      text: buffer.toString('utf8', offset + 8, offset + 8 + size)
    });
    offset += 8 + size;
  }

  return { frames, rest: buffer.slice(offset) };
}

// Turn demuxed frames into log line objects
function framesToLogLines(frames) {
  const lines = [];

  frames.forEach((frame, frameIndex) => {
    frame.text.split('\n').forEach((rawLine, lineIndex) => {
      const line = rawLine.replace(/\r$/, '');
      if (!line.trim()) return;

      const timestampMatch = line.match(/^(\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}\.?\d*Z?)\s*(.*)/);

      lines.push({
        id: `${Date.now()}-${frameIndex}-${lineIndex}`,
        timestamp: timestampMatch ? timestampMatch[1] : new Date().toISOString(),
        message: timestampMatch ? timestampMatch[2] || '' : line,
        stream: frame.stream
      });
    });
  });

  return lines;
}

// Parse a complete Docker log buffer
function parseDockerLogs(buffer) {
  const { frames } = demuxDockerStream(buffer);
  return framesToLogLines(frames);
}

module.exports = { demuxDockerStream, framesToLogLines, parseDockerLogs };
