import { test } from 'node:test';
import assert from 'node:assert/strict';
import { domainOf, parseIspdb, presetFor } from '../src/notify/autoconfig.js';
import { mailConfigFrom, publicSettings, SECRET_MASK, type FormSettings } from '../src/settings.js';

test('Autokonfiguration: Domain, bekannte Anbieter, ISPDB-XML', () => {
  assert.equal(domainOf(' Name@GMX.de '), 'gmx.de');
  assert.equal(domainOf('kaputt'), '');
  const gmx = presetFor('max@gmx.de');
  assert.equal(gmx?.host, 'mail.gmx.net');
  assert.equal(gmx?.port, 587);
  assert.equal(gmx?.secure, false);
  assert.equal(gmx?.user, 'max@gmx.de');
  assert.equal(presetFor('x@outlook.com')?.provider, 'm365');
  assert.equal(presetFor('x@gmail.com')?.oauth, 'gmail');
  assert.equal(presetFor('x@firma-ohne-preset.de'), undefined);
  const xml = `<clientConfig version="1.1"><emailProvider id="example.com">
    <incomingServer type="imap"><hostname>imap.example.com</hostname><port>993</port><socketType>SSL</socketType></incomingServer>
    <outgoingServer type="smtp"><hostname>smtp.example.com</hostname><port>465</port><socketType>SSL</socketType><username>%EMAILLOCALPART%</username></outgoingServer>
  </emailProvider></clientConfig>`;
  const s = parseIspdb(xml, 'max@example.com');
  assert.deepEqual(s, { provider: 'smtp', host: 'smtp.example.com', port: 465, secure: true, user: 'max', source: 'ispdb' });
  assert.equal(parseIspdb('<clientConfig/>', 'a@b.de'), undefined);
});

test('Mail-Einstellungen: Konfiguration ableiten, Kennwörter maskieren', () => {
  const base = { mailProvider: 'smtp', mailTo: '', mailFrom: '', smtpHost: 'smtp.example.com', smtpPort: '', smtpSecure: 'on', smtpUser: 'max@example.com', smtpPass: 'geheim', mailClientId: '', mailClientSecret: '', mailTenant: '', mailUser: '' } as FormSettings;
  const m = mailConfigFrom(base);
  assert.equal(m.provider, 'smtp');
  assert.equal(m.to, 'max@example.com'); // leer = Postfach
  assert.equal(m.smtp?.port, 465); // leer + SSL -> 465
  assert.equal(m.smtp?.pass, 'geheim');
  assert.equal(m.oauth, undefined);
  const g = mailConfigFrom({ ...base, mailProvider: 'gmail', mailUser: 'a@gmail.com', mailClientId: 'id', mailTenant: '' });
  assert.equal(g.provider, 'gmail');
  assert.equal(g.to, 'a@gmail.com');
  assert.equal(g.oauth?.tenant, 'common');
  const pub = publicSettings(base);
  assert.equal(pub.smtpPass, SECRET_MASK);
  assert.equal(pub.smtpUser, 'max@example.com');
  assert.equal(publicSettings({ ...base, smtpPass: '' }).smtpPass, '');
});
