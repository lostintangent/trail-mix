/**
 * Stands in for TanStack Start's server functions, which only Start's own build can compile. A
 * call travels to the harness as Start's would, with its data, and the harness answers it.
 */
export function createServerFn({ method }: { method: 'GET' | 'POST' }) {
  const builder = {
    validator: () => builder,
    handler:
      () =>
      async ({ data }: { data: unknown }): Promise<unknown> => {
        const response = await fetch('/_serverFn', {
          method: 'POST',
          headers: { 'content-type': 'application/json', 'x-server-fn-method': method },
          body: JSON.stringify(data),
        });
        if (!response.ok) throw new Error(`The harness answered ${response.status}.`);
        return response.json();
      },
  };
  return builder;
}
