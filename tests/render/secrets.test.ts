import { describe, expect, it } from 'vitest';
import { leaksSecret } from '../../src/render/secrets.js';

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
});
