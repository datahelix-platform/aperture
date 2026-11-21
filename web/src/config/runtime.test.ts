import { resolveEndpoint } from '../data/endpoint';
import { runtimeEnv } from './runtime';

type ConfigWindow = { __APERTURE_CONFIG__?: unknown };

afterEach(() => {
  delete (globalThis as ConfigWindow).__APERTURE_CONFIG__;
});

describe('runtime config overlay (issue #22)', () => {
  it('is a no-op when window.__APERTURE_CONFIG__ is absent', () => {
    expect(resolveEndpoint(runtimeEnv())).toEqual({ url: null });
  });

  it('runtime values override the build-time env', () => {
    (globalThis as ConfigWindow).__APERTURE_CONFIG__ = {
      VITE_GRAPHQL_URL: 'http://runtime.test/graphql',
    };
    expect(resolveEndpoint(runtimeEnv())).toEqual({ url: 'http://runtime.test/graphql' });
  });

  it('ignores a malformed overlay', () => {
    (globalThis as ConfigWindow).__APERTURE_CONFIG__ = 'not-an-object';
    expect(resolveEndpoint(runtimeEnv())).toEqual({ url: null });
  });

  it('passes a relative (same-origin) endpoint through untouched', () => {
    // Same-origin deployments (e.g. the DataHelix solo recipe) reverse-proxy
    // the GraphQL endpoint next to the SPA and inject a path-only URL; the
    // browser's fetch resolves it against the page origin. resolveEndpoint
    // must not require an absolute URL.
    (globalThis as ConfigWindow).__APERTURE_CONFIG__ = {
      VITE_GRAPHQL_URL: '/graphql',
    };
    expect(resolveEndpoint(runtimeEnv())).toEqual({ url: '/graphql' });
  });
});
