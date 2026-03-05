#!/usr/bin/env node

require('dotenv/config');

const fs = require('fs');
const path = require('path');
const crypto = require('crypto');

const rag = require('../lib/openai-rag');

function sha1(s) {
  return crypto.createHash('sha1').update(s).digest('hex');
}

function splitIntoChunks(text, maxChars = 5000) {
  const lines = text.split(/\r?\n/);
  const chunks = [];
  let buf = [];
  let len = 0;
  for (const line of lines) {
    if (len + line.length + 1 > maxChars && buf.length) {
      chunks.push(buf.join('\n'));
      buf = [];
      len = 0;
    }
    buf.push(line);
    len += line.length + 1;
  }
  if (buf.length) chunks.push(buf.join('\n'));
  return chunks;
}

async function main() {
  const file = process.env.MEMORY_MD || path.resolve(__dirname, '../../../MEMORY.md');
  if (!fs.existsSync(file)) throw new Error(`Not found: ${file}`);

  const text = fs.readFileSync(file, 'utf-8');
  const chunks = splitIntoChunks(text, 5000);

  console.log(`Importing ${chunks.length} chunks from ${file}`);

  let i = 0;
  for (const chunk of chunks) {
    i++;
    const id = `memmd_${sha1(file + '|' + i + '|' + chunk).slice(0, 16)}`;
    await rag.storeMemory({
      id,
      type: 'note',
      content: chunk,
      context: 'workspace-coder/MEMORY.md',
      tier: 'hot',
      importance: 9,
      agent: 'system',
      tags: ['import:memory-md', 'source:workspace-coder']
    });
    console.log(`- chunk ${i}/${chunks.length} ok (${chunk.length} chars)`);
  }

  console.log('Done');
}

main().catch((e) => {
  console.error(e);
  process.exit(1);
});
