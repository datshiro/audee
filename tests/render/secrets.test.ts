import { describe, expect, it } from 'vitest';
import { leaksSecret, redactSecretPairs } from '../../src/render/secrets.js';

// ciel/kbquery_test.go:366-397 TestKBQuerySecretFilter, case for case
const CIEL_CASES: Array<[string, boolean]> = [
  ['The token bucket refills every second; see config key rate_limit.', false],
  ['Config reads password: ${DB_PASSWORD} from the env.', false],
  ['client_secret = os.Getenv("CLIENT_SECRET")', false],
  ['accessToken = jwt.Sign(claims)', false],
  ['pwd=/home/app/service', false],
  ['it uses sk-learn-preprocessing-pipeline', false],
  ['token: %(TOKEN)s in the template', false],
  ['-----BEGIN RSA PRIVATE KEY-----', true],
  ['mongo at mongodb://app:hunter2hunter@10.0.0.1:27017', true],
  ['set api_key: "abcd1234efgh5678"', true],
  ['client_secret=Zx9aB8cD7eF6gH5', true],
  ['JWTSecret: Zx9aB8cD7eF6gH5', true],
  ['PortalApiKey = "Zx9aB8cD7eF6gH5"', true],
  ['SASLPassword=Zx9aB8cD7eF6gH5', true],
  ['jwtSecret := "Zx9aB8cD7eF6gH5"', true],
  ['apiKey := os.Getenv("API_KEY")', false],
  ['password := req.Password', false],
  ['secret := cfg.JWTSecret', false],
  ['accessToken := resp.AccessToken', false],
  ['use glpat-abcdefghijklmnopqrst', true],
  ['key sk-abcdefghijklmnopqrstuvwx', true],
];

describe('secret filter', () => {
  it.each(CIEL_CASES)('TestKBQuerySecretFilter %j', (text, leak) => {
    expect(leaksSecret([text])).toBe(leak);
  });
  it('TestSecretFilterCatchesAnthropicAndGrafanaKeys', () => {
    for (const t of ['sk-ant-api03-abcdefghijklmnopqrstuvwxyz0123', 'glsa_abcdefghijklmnopqrstuvwxyz', 'glpat-abcdefghijklmnopqrstuvwxyz', 'glcbt-abcdefghijklmnopqrstuvwxyz']) {
      expect(leaksSecret(['value ' + t]), t).toBe(true);
    }
    expect(leaksSecret(['sk-ant-short', 'glsa_short'])).toBe(false);
  });
  it('TestSecretFilterCatchesKnownSecret', () => {
    expect(leaksSecret(['the answer mentions hunter2-plain-value here'], ['hunter2-plain-value'])).toBe(true);
    expect(leaksSecret(['nothing here'], ['hunter2-plain-value'])).toBe(false);
    expect(leaksSecret(['nothing here'], [''])).toBe(false);
  });
  it('redacts secret pairs', () => {
    const redacted = redactSecretPairs('{"pushToken":"abcdefghijkl12","x":1}');
    expect(redacted).toBe('{"pushToken":"<redacted>","x":1}');
    expect(leaksSecret([redacted])).toBe(false);
    expect(redactSecretPairs('token: ${VAR}')).toBe('token: ${VAR}');
    expect(redactSecretPairs('secret := cfg.JWTSecret')).toBe('secret := cfg.JWTSecret');
    expect(redactSecretPairs('glsa_abcdefghijklmnopqrstuvwxyz')).toBe('glsa_abcdefghijklmnopqrstuvwxyz');
    expect(leaksSecret([redactSecretPairs('glsa_abcdefghijklmnopqrstuvwxyz')])).toBe(true);
  });
  it('redacts secret pairs inside JSON-escaped quotes', () => {
    const escaped = 'push sent {\\"pushToken\\":\\"abcdefghijkl12\\",\\"x\\":1}';
    expect(leaksSecret([escaped])).toBe(true); // the leak check sees the unescaped form too
    const redacted = redactSecretPairs(escaped);
    expect(redacted).toBe('push sent {"pushToken":"<redacted>","x":1}');
    expect(leaksSecret([redacted])).toBe(false);
  });
  it('redacts secret pairs inside double-escaped JSON', () => {
    const twice = String.raw`body "{\\"pushToken\\":\\"abcdefghijkl12\\"}"`;
    expect(leaksSecret([twice])).toBe(true);
    const redacted = redactSecretPairs(twice);
    expect(redacted).toBe('body "{"pushToken":"<redacted>"}"');
    expect(leaksSecret([redacted])).toBe(false);
    expect(redactSecretPairs(String.raw`{\\\\"token\\\\":\\\\"abcdefghijkl12\\\\"}`)).toBe('{"token":"<redacted>"}');
  });
  it('catches and redacts Bearer and Basic credentials', () => {
    const cases: Array<[string, string]> = [
      ['Authorization: Bearer abcDEF123456ghiJKL789', 'Authorization: Bearer <redacted>'],
      ['header authorization: bearer eyJhbGciOiJIUzI1NiJ9xyz', 'header authorization: bearer <redacted>'],
      ['"Authorization":"Basic dXNlcjpwYXNzd29yZDEyMw=="', '"Authorization":"Basic <redacted>"'],
      ['sent with Bearer a1b2c3d4e5f6g7h8, ok', 'sent with Bearer <redacted>, ok'],
    ];
    for (const [text, redacted] of cases) {
      expect(leaksSecret([text]), text).toBe(true);
      expect(redactSecretPairs(text), text).toBe(redacted);
      expect(leaksSecret([redacted]), redacted).toBe(false);
    }
    // Too short, a placeholder without a digit or =, or prose: not a credential.
    for (const text of ['Bearer token', 'Bearer abc123', 'Authorization: Bearer YOUR_ACCESS_TOKEN_HERE', 'Basic internationalization', 'basic auth/token-based flows', 'basic read-only/write-only split', 'Bearer <redacted>']) {
      expect(leaksSecret([text]), text).toBe(false);
      expect(redactSecretPairs(text), text).toBe(text);
    }
  });
  it('still catches a secret pair whose value starts with a bracket', () => {
    for (const text of ['password=[s3cr3tpassw0rd]', 'token=[abcdef123456]', 'api_key=[AbCdEf123456]', 'secret: [hunter2hunter2]', 'password = "[hunter2hunter2]"', 'password=[x1234567']) {
      expect(leaksSecret([text]), text).toBe(true);
      expect(leaksSecret([redactSecretPairs(text)]), text).toBe(false);
    }
  });
  it('catches and redacts push registration and device keys', () => {
    const cases: Array<[string, string]> = [
      ['{"registration_id":"APA91bHabcdefgh123"}', '{"registration_id":"<redacted>"}'],
      ['{"fcm_token":"dGhpcyBpcyBhIHRva2Vu"}', '{"fcm_token":"<redacted>"}'],
      ['device_token=0123456789abcdef', 'device_token=<redacted>'],
      ['{"deviceToken":"f00dbabe12345678"}', '{"deviceToken":"<redacted>"}'],
      ['{"device_id":"A1B2C3D4E5F6"}', '{"device_id":"<redacted>"}'],
      ['{"registration_ids":["APA91bHfirst0001","APA91bHsecond002"]}', '{"registration_ids":["<redacted>","<redacted>"]}'],
      ['registration_ids: [APA91bHfirst0001, APA91bHsecond002]', 'registration_ids: [<redacted>, <redacted>]'],
      ['{"registrationId":"APA91bHabcdefgh123"}', '{"registrationId":"<redacted>"}'],
      ['{"deviceId":"A1B2C3D4E5F6G7H8"}', '{"deviceId":"<redacted>"}'],
      ['regId=APA91bHabcdefgh123', 'regId=<redacted>'],
      ['{"fcm_tokens":["APA91bHfirst0001","APA91bHsecond002"]}', '{"fcm_tokens":["<redacted>","<redacted>"]}'],
      ['device_tokens=[APA91bHfirst0001, APA91bHsecond002]', 'device_tokens=[<redacted>, <redacted>]'],
    ];
    for (const [text, redacted] of cases) {
      expect(leaksSecret([text]), text).toBe(true);
      expect(redactSecretPairs(text), text).toBe(redacted);
      expect(leaksSecret([redacted]), redacted).toBe(false);
    }
    expect(leaksSecret([`sent push to ${'dGhpc0123'}:APA91b${'x'.repeat(45)} ok`])).toBe(true);
    expect(leaksSecret(['{"registration_ids":[]}', '{"device_id":"<redacted>"}'])).toBe(false);
  });
});
