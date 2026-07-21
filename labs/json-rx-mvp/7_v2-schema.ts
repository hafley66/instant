import * as z from "zod";

const JsonPrimitiveSchema = z.union([z.null(), z.boolean(), z.number(), z.string()]);
const ParameterSchema = z.strictObject({
  type: z.enum(["boolean", "integer", "number", "string"]),
  default: JsonPrimitiveSchema.optional(),
});
const ParametersSchema = z.strictObject({
  path: z.record(z.string(), ParameterSchema).optional(),
  query: z.record(z.string(), ParameterSchema).optional(),
});

const SourceExpressionSchema = z.strictObject({
  node: z.string().min(1),
  source: z.strictObject({ ref: z.string().min(1) }),
});

const ProjectExpressionSchema = z.strictObject({
  node: z.string().min(1),
  project: z.strictObject({
    input: z.lazy(() => ObservableExpressionSchema),
    from: z.string().regex(/^\$\.(?:[A-Za-z_][A-Za-z0-9_]*\.?)+$/),
    fields: z.record(
      z.string().min(1),
      z.string().regex(/^\$\.(?:[A-Za-z_][A-Za-z0-9_]*\.?)+$/),
    ),
  }),
});

const ShareReplayExpressionSchema = z.strictObject({
  node: z.string().min(1),
  shareReplay: z.strictObject({
    input: z.lazy(() => ObservableExpressionSchema),
    bufferSize: z.literal(1),
    refCount: z.literal(true),
  }),
});

const ObservableExpressionSchema: z.ZodType<ObservableExpression> = z.lazy(() => z.union([
  SourceExpressionSchema,
  ProjectExpressionSchema,
  ShareReplayExpressionSchema,
]));

export type ObservableExpression =
  | z.infer<typeof SourceExpressionSchema>
  | {
      node: string;
      project: {
        input: ObservableExpression;
        from: string;
        fields: Record<string, string>;
      };
    }
  | {
      node: string;
      shareReplay: {
        input: ObservableExpression;
        bufferSize: 1;
        refCount: true;
      };
    };

const NetworkResponseBindingSchema = z.strictObject({
  kind: z.literal("browser.network.response"),
  page: z.strictObject({ host: z.string().min(1) }),
  request: z.strictObject({
    methods: z.array(z.string().min(1)).min(1),
    url: z.string().min(1),
  }),
});

const DashboardOutputSchema = z.strictObject({
  kind: z.literal("instant.dashboard.emit"),
  flow: z.string().min(1),
  stream: z.string().min(1),
  schema: z.record(z.string(), z.unknown()),
});

export const AutomationV2Schema = z.strictObject({
  version: z.literal("automation.v2"),
  profile: z.literal("rxjs-7.8"),
  id: z.string().min(1),
  enabled: z.boolean().default(true),
  bindings: z.strictObject({
    sources: z.record(z.string().min(1), NetworkResponseBindingSchema),
  }),
  circuit: z.strictObject({
    sources: z.record(
      z.string().min(1),
      z.strictObject({ parameters: ParametersSchema.optional() }),
    ),
    flows: z.record(
      z.string().min(1),
      z.strictObject({
        parameters: ParametersSchema.optional(),
        expression: ObservableExpressionSchema,
      }),
    ),
  }),
  outputs: z.array(DashboardOutputSchema).min(1),
}).superRefine((automation, context) => {
  const sourceRefs = new Set(Object.keys(automation.circuit.sources));
  const flowRefs = new Set(Object.keys(automation.circuit.flows));
  const nodes = new Set<string>();

  for (const bindingRef of Object.keys(automation.bindings.sources)) {
    if (!sourceRefs.has(bindingRef)) {
      context.addIssue({
        code: "custom",
        path: ["bindings", "sources", bindingRef],
        message: `binding references unknown source: ${bindingRef}`,
      });
    }
  }

  const visit = (expression: ObservableExpression, flowRef: string) => {
    if (nodes.has(expression.node)) {
      context.addIssue({
        code: "custom",
        path: ["circuit", "flows", flowRef, "expression"],
        message: `duplicate node id: ${expression.node}`,
      });
    }
    nodes.add(expression.node);
    if ("source" in expression && !sourceRefs.has(expression.source.ref)) {
      context.addIssue({
        code: "custom",
        path: ["circuit", "flows", flowRef, "expression", "source", "ref"],
        message: `unknown source: ${expression.source.ref}`,
      });
    }
    if ("project" in expression) visit(expression.project.input, flowRef);
    if ("shareReplay" in expression) visit(expression.shareReplay.input, flowRef);
  };
  for (const [flowRef, definition] of Object.entries(automation.circuit.flows)) {
    visit(definition.expression, flowRef);
  }
  for (const [index, output] of automation.outputs.entries()) {
    if (!flowRefs.has(output.flow)) {
      context.addIssue({
        code: "custom",
        path: ["outputs", index, "flow"],
        message: `output references unknown flow: ${output.flow}`,
      });
    }
  }
});

export type AutomationV2 = z.infer<typeof AutomationV2Schema>;

export const AutomationV2JsonSchema = z.toJSONSchema(AutomationV2Schema, {
  target: "draft-2020-12",
  cycles: "ref",
  reused: "ref",
});
