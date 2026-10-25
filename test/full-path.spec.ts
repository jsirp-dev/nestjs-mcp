import { RequestMethod, VERSION_NEUTRAL, VersioningType } from '@nestjs/common';
import { rawPath, routeVersion, type PathSettings } from '../src/routes/full-path.js';

const uri = (extra: Partial<PathSettings> = {}): PathSettings => ({
  globalPrefix: 'api',
  versioning: { type: VersioningType.URI },
  exclude: [],
  ...extra,
});

describe('routeVersion', () => {
  it('serialises VERSION_NEUTRAL as neutral', () => {
    expect(routeVersion(VERSION_NEUTRAL, '/api/_mcp', uri())).toBe('neutral');
  });

  it('resolves a URI version list to the version in the path', () => {
    const versions = ['1', '2', VERSION_NEUTRAL];
    expect(routeVersion(versions, '/api/v2/cats', uri())).toBe('2');
    expect(routeVersion(versions, '/api/cats', uri())).toBe('neutral');
  });

  it('keeps the list for header versioning', () => {
    const header = uri({ versioning: { type: VersioningType.HEADER, header: 'x-v' } });
    expect(routeVersion(['1', VERSION_NEUTRAL], '/api/cats', header)).toEqual(['1', 'neutral']);
  });

  it('is undefined when the route declares none', () => {
    expect(routeVersion(undefined, '/api/cats', uri())).toBeUndefined();
  });
});

describe('rawPath', () => {
  it('strips the prefix and the URI version segment', () => {
    expect(rawPath('/api/v1/cats/:id', 'GET', '1', uri())).toBe('/cats/:id');
    expect(rawPath('/api/v1', 'GET', '1', uri())).toBe('/');
  });

  it('honours a custom or disabled URI version prefix', () => {
    expect(
      rawPath(
        '/api/ver1/cats',
        'GET',
        '1',
        uri({ versioning: { type: VersioningType.URI, prefix: 'ver' } }),
      ),
    ).toBe('/cats');
    expect(
      rawPath(
        '/api/1/cats',
        'GET',
        '1',
        uri({ versioning: { type: VersioningType.URI, prefix: false } }),
      ),
    ).toBe('/cats');
  });

  it('strips the prefix only as a whole segment', () => {
    expect(rawPath('/apis/cats', 'GET', undefined, uri())).toBe('/apis/cats');
  });

  it('keeps a path that starts like the prefix when the route is excluded from it', () => {
    const exclude = [{ requestMethod: RequestMethod.GET, pathRegex: /^\/api\/health$/ }];
    expect(rawPath('/api/health', 'GET', undefined, uri({ exclude }))).toBe('/api/health');
    expect(rawPath('/api/health', 'POST', undefined, uri({ exclude }))).toBe('/health');
  });

  it('leaves header-versioned paths alone', () => {
    const header = uri({ versioning: { type: VersioningType.HEADER, header: 'x-v' } });
    expect(rawPath('/api/cats', 'GET', '1', header)).toBe('/cats');
  });
});
