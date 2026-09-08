import worker, { type Env } from '../../worker/index';

interface TestEnv extends Env {
  WRITE_CONTROL: Fetcher;
}

export default {
  fetch(request: Request, env: TestEnv) {
    const bucket = new Proxy(env.MOCKS, {
      get(target, property) {
        if (property === 'put') {
          return async (...args: Parameters<R2Bucket['put']>) => {
            const control = await env.WRITE_CONTROL.fetch('https://write-control.test/put', {
              method: 'POST',
              body: JSON.stringify({ key: args[0] }),
            });
            if (!control.ok) throw new Error('Injected R2 write interruption.');
            return target.put(...args);
          };
        }
        const value = Reflect.get(target, property);
        return typeof value === 'function' ? value.bind(target) : value;
      },
    });
    return worker.fetch(request, { ...env, MOCKS: bucket });
  },
};
