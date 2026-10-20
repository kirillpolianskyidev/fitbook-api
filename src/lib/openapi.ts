import {OpenAPIRegistry, OpenApiGeneratorV31} from '@asteasolutions/zod-to-openapi';

export const registry = new OpenAPIRegistry();

registry.registerComponent('securitySchemes', 'bearerAuth', {
  type: 'http',
  scheme: 'bearer',
  bearerFormat: 'JWT',
});

export function generateOpenApiDocument() {
  const generator = new OpenApiGeneratorV31(registry.definitions);
  return generator.generateDocument({
    openapi: '3.1.0',
    info: {
      title: 'FitBook API',
      version: '1.0.0',
      description:
        'Backend for FitBook: coach catalog, availability, individual and group bookings (single and recurring), ' +
        'free trial, mock payments, notes and realtime chat. All dates are ISO 8601 UTC; money is integer cents.',
    },
    servers: [{url: 'http://localhost:3000'}],
  });
}
