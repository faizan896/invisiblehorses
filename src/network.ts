import { EnvHttpProxyAgent, setGlobalDispatcher } from 'undici';

/** Node 20 fetch does not automatically honor HTTPS_PROXY. Keep TLS verification enabled. */
export function configureProxy() {
  if (process.env.HTTPS_PROXY || process.env.https_proxy || process.env.HTTP_PROXY || process.env.http_proxy) {
    const noProxy = [process.env.no_proxy ?? process.env.NO_PROXY ?? '', 'localhost', '127.0.0.1', '::1'].join(',');
    setGlobalDispatcher(new EnvHttpProxyAgent({ noProxy }));
  }
}
