import { PrecomputedTexturesLoader } from '@takram/three-atmosphere';
import { LoadingManager } from 'three';

export function createTerrainAtmosphereTextureRuntime({
  baseUrl,
  cacheName,
  fileNames,
  targets,
  bootLog = () => {},
  testOverrides = {},
} = {}) {
  const {
    LoadingManager: LoadingManagerImpl = LoadingManager,
    PrecomputedTexturesLoader: PrecomputedTexturesLoaderImpl = PrecomputedTexturesLoader,
    window: windowImpl = globalThis.window,
    caches: cachesImpl = globalThis.caches,
    fetch: fetchImpl = (...args) => fetch(...args),
    URL: URLImpl = globalThis.URL,
    console: consoleImpl = globalThis.console,
  } = testOverrides;
  function revokeObjectUrls(urlMap) {
    for (const objectUrl of urlMap.values()) URLImpl.revokeObjectURL(objectUrl);
  }

  function apply(textures) {
    bootLog('atmosphere.textures.apply', { keys: Object.keys(textures || {}) });
    for (const target of targets) Object.assign(target, textures);
  }

  function load(url = baseUrl, manager) {
    bootLog('atmosphere.loader.start', { url, viaManager: Boolean(manager) });
    new PrecomputedTexturesLoaderImpl({}, manager).load(
      url,
      textures => {
        bootLog('atmosphere.loader.success', { url });
        apply(textures);
      },
      undefined,
      error => bootLog('atmosphere.loader.error', {
        url,
        message: error?.message ?? String(error),
        stack: error?.stack ?? null,
      }),
    );
  }

  async function prepareUrlMap(url = baseUrl) {
    bootLog('atmosphere.cache.prepare.start', { baseUrl: url, fileCount: fileNames.length });
    if (!windowImpl || !('caches' in windowImpl)) {
      bootLog('atmosphere.cache.prepare.no-cache-api');
      return null;
    }
    const cache = await cachesImpl.open(cacheName);
    const urlMap = new Map();
    let cacheHits = 0;
    let networkHits = 0;

    for (const fileName of fileNames) {
      const sourceUrl = `${url}/${fileName}`;
      let response = await cache.match(sourceUrl);
      let source = 'cache';
      if (response != null) {
        cacheHits += 1;
      } else {
        source = 'network';
        response = await fetchImpl(sourceUrl);
        if (!response.ok) {
          throw new Error(`atmosphere texture fetch failed: ${response.status} ${sourceUrl}`);
        }
        await cache.put(sourceUrl, response.clone());
        networkHits += 1;
      }
      const blob = await response.blob();
      bootLog('atmosphere.cache.file.ready', { fileName, source, bytes: blob.size });
      urlMap.set(sourceUrl, URLImpl.createObjectURL(blob));
    }

    bootLog('atmosphere.cache.prepare.done', { cacheHits, networkHits });
    return { urlMap, cacheHits, networkHits };
  }

  function loadWithLocalCache() {
    bootLog('atmosphere.cache.load-sequence.start');
    return prepareUrlMap().then(result => {
      if (result == null) {
        bootLog('atmosphere.cache.load-sequence.fallback-direct');
        load();
        return;
      }

      const manager = new LoadingManagerImpl();
      manager.setURLModifier(url => result.urlMap.get(url) ?? url);
      consoleImpl.info(
        '[clouds-terrain-managed-flask-ux-wip] Atmosphere LUT cache prepared. ' +
          `cacheHits=${result.cacheHits} network=${result.networkHits}`,
      );
      bootLog('atmosphere.cache.manager.ready', {
        cacheHits: result.cacheHits,
        networkHits: result.networkHits,
      });

      let released = false;
      const release = () => {
        if (released) return;
        released = true;
        revokeObjectUrls(result.urlMap);
        bootLog('atmosphere.cache.object-urls.revoked');
      };

      bootLog('atmosphere.cache.loader.start');
      new PrecomputedTexturesLoaderImpl({}, manager).load(
        baseUrl,
        textures => {
          bootLog('atmosphere.cache.loader.success');
          apply(textures);
          release();
        },
        undefined,
        error => {
          bootLog('atmosphere.cache.loader.error', {
            message: error?.message ?? String(error),
            stack: error?.stack ?? null,
          });
          release();
          load();
        },
      );
    }).catch(error => {
      const message = error instanceof Error ? error.message : String(error);
      bootLog('atmosphere.cache.load-sequence.error', {
        message,
        stack: error?.stack ?? null,
      });
      consoleImpl.warn(
        `[clouds-terrain-managed-flask-ux-wip] Atmosphere cache setup failed: ${message}`,
      );
      load();
    });
  }

  return { apply, load, loadWithLocalCache, prepareUrlMap, revokeObjectUrls };
}
