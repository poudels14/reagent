import React from "react";
import { createAgentNode, z } from "@useportal/reagent/agent";

const AgentError = createAgentNode({
  id: "@useportal/demo-agents/agent-error",
  name: "Show Agent Error",
  version: "0.0.1",
  input: z.object({
    error: z.string().label("Error"),
  }),
  output: z.object({}),
  async *execute(context, input) {
    context.render(
      (props) => <div className="text-red-700">Error: {props.data.error}</div>,
      {
        error: input.error,
      }
    );
  },
});

export { AgentError };
