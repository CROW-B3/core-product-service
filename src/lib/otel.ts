import type { ResolveConfigFn } from '@microlabs/otel-cf-workers';

export function createOtelConfig(serviceName: string): ResolveConfigFn {
  return (env: Record<string, unknown>, _trigger: unknown) => ({
    exporter: {
      url: 'https://api.axiom.co/v1/traces',
      headers: {
        Authorization: `Bearer ${env.AXIOM_API_TOKEN}`,
        'X-Axiom-Dataset': env.AXIOM_DATASET as string,
      },
    },
    service: { name: serviceName },
  });
}
