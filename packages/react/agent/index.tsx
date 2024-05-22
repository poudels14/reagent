import { useMemo } from "react";

import { useAgentContext } from "./context";
import { Chat } from "../chat/types";

const AgentNodeUI = (props: {} & Chat.Message["message"]["ui"]) => {
  "use client";
  const { nodesByTypeId } = useAgentContext();
  const components = useMemo(() => {
    const node = nodesByTypeId[props.node.type];
    // ignore UI rendering if agent node not found
    if (!node) {
      return [];
    }
    // @ts-expect-error
    return [...node.run()].reduce(
      (agg, curr) => {
        agg[curr[0]] = curr[1];
        return agg;
      },
      {} as Record<string, () => JSX.Element>
    );
  }, [props.node.type, nodesByTypeId]);

  const Component = useMemo(() => {
    return components[props.render.step];
  }, [props.render.step, components]);

  if (!Component) {
    return <></>;
  }
  return Component({ data: props.render.data });
};

export { AgentNodeUI };
export { useAgentContext, AgentContextProvider } from "./context";
