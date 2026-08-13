import assert from 'node:assert/strict';
import { mkdtemp, mkdir, rm, writeFile } from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import test from 'node:test';
import { ReferenceService } from '../src/main/reference-service.js';

test('reference folder indexes text and returns page-style grounded hits', async (t) => {
  const root = await mkdtemp(path.join(os.tmpdir(), 'codetutor-next-reference-'));
  t.after(() => rm(root, { recursive: true, force: true }));
  const data = path.join(root, 'data');
  const references = path.join(root, 'references');
  await mkdir(data); await mkdir(references);
  await writeFile(path.join(references, 'spi-notes.md'), 'CTAR 레지스터는 SPI 프레임 크기와 클록 위상을 설정한다.', 'utf8');

  const service = new ReferenceService();
  await service.bind(data);
  const status = await service.setFolder(references);
  assert.equal(status.documents.length, 1);
  const hit = service.search('SPI CTAR 레지스터')[0];
  assert.equal(hit?.document, 'spi-notes.md');
  assert.equal(hit?.citation, '[[spi-notes.md:p.1]]');
  assert.equal(service.hasDocument('spi-notes.md', 1), true);
});

test('reference folder extracts text from individual PDF pages', async (t) => {
  const root = await mkdtemp(path.join(os.tmpdir(), 'codetutor-next-reference-pdf-'));
  t.after(() => rm(root, { recursive: true, force: true }));
  const data = path.join(root, 'data'); const references = path.join(root, 'references');
  await mkdir(data); await mkdir(references);
  const pdf = 'JVBERi0xLjcKJcK1wrYKJSBXcml0dGVuIGJ5IE11UERGIDEuMjcuMgoKMSAwIG9iago8PC9UeXBlL0NhdGFsb2cvUGFnZXMgMiAwIFIvSW5mbzw8L1Byb2R1Y2VyKE11UERGIDEuMjcuMik+Pj4+CmVuZG9iagoKMiAwIG9iago8PC9UeXBlL1BhZ2VzL0NvdW50IDIvS2lkc1s0IDAgUiA4IDAgUl0+PgplbmRvYmoKCjMgMCBvYmoKPDwvRm9udDw8L2hlbHYgNSAwIFI+Pj4+CmVuZG9iagoKNCAwIG9iago8PC9UeXBlL1BhZ2UvTWVkaWFCb3hbMCAwIDU5NSA4NDJdL1JvdGF0ZSAwL1Jlc291cmNlcyAzIDAgUi9QYXJlbnQgMiAwIFIvQ29udGVudHNbNiAwIFJdPj4KZW5kb2JqCgo1IDAgb2JqCjw8L1R5cGUvRm9udC9TdWJ0eXBlL1R5cGUxL0Jhc2VGb250L0hlbHZldGljYS9FbmNvZGluZy9XaW5BbnNpRW5jb2Rpbmc+PgplbmRvYmoKCjYgMCBvYmoKPDwvTGVuZ3RoIDExMy9GaWx0ZXIvRmxhdGVEZWNvZGU+PgpzdHJlYW0KeNotjLEKw0AMQ3d/hf+gZ+dOSqB0KGTJVvBWOpU7MrRDl35/HSgaJJ5syUeuIaYlZUpXsmi85bT311fNNIbezxVY6JxYvbDAQLRMFY3zwQAMerqxJR1HR8+7zgnPpBULBvr/J3cuj9hkDbnJDzUlHKwKZW5kc3RyZWFtCmVuZG9iagoKNyAwIG9iago8PC9Gb250PDwvaGVsdiA1IDAgUj4+Pj4KZW5kb2JqCgo4IDAgb2JqCjw8L1R5cGUvUGFnZS9NZWRpYUJveFswIDAgNTk1IDg0Ml0vUm90YXRlIDAvUmVzb3VyY2VzIDcgMCBSL1BhcmVudCAyIDAgUi9Db250ZW50c1s5IDAgUl0+PgplbmRvYmoKCjkgMCBvYmoKPDwvTGVuZ3RoIDExMy9GaWx0ZXIvRmxhdGVEZWNvZGU+PgpzdHJlYW0KeNoti7EKAkEQQ/v5ivkDd3Z3EgWxOLCxE6Y7rpJdLLSw8fudA0mR8JLIR5YQ05IyZVWyaLzl8Byvr5ppTF3P3uBomBjotbDAQHimDueRyQBM1nSjJ517x5q7wYZH0o7T/v9/Gvtli5tcQ+7yA4uDHXIKZW5kc3RyZWFtCmVuZG9iagoKeHJlZgowIDEwCjAwMDAwMDAwMDAgNjU1MzUgZiAKMDAwMDAwMDA0MiAwMDAwMCBuIAowMDAwMDAwMTIwIDAwMDAwIG4gCjAwMDAwMDAxNzggMDAwMDAgbiAKMDAwMDAwMDIxOSAwMDAwMCBuIAowMDAwMDAwMzI2IDAwMDAwIG4gCjAwMDAwMDA0MTUgMDAwMDAgbiAKMDAwMDAwMDU5NyAwMDAwMCBuIAowMDAwMDAwNjM4IDAwMDAwIG4gCjAwMDAwMDA3NDUgMDAwMDAgbiAKCnRyYWlsZXIKPDwvU2l6ZSAxMC9Sb290IDEgMCBSL0lEWzw0OUMzQkZDMzlENjg1QjIxNkNDM0I1QzNCNUMzOTM3Qj48MUU4MDVCQUM5REE4RUM4NDM1NUM0RDRCMEVGOEFFMDU+XT4+CnN0YXJ0eHJlZgo5MjcKJSVFT0YK';
  await writeFile(path.join(references, 'two-pages.pdf'), Buffer.from(pdf, 'base64'));
  const service = new ReferenceService(); await service.bind(data);
  const status = await service.setFolder(references);
  assert.equal(status.documents[0]?.pages, 2);
  assert.equal(service.search('Second page translation')[0]?.citation, '[[two-pages.pdf:p.2]]');
});
