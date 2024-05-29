import { GraphAgent } from "@useportal/reagent/agent";
import { ChatCompletionWithTools, User } from "@useportal/reagent/agent/nodes";

import { GetWeather } from "./tools/Weather";
import { createInputNode } from "./input";
import { AgentError } from "./tools/AgentError";

const agent = new GraphAgent();

const input = agent.addNode("input", createInputNode());
const error = agent.addNode("error", new AgentError());

const chat1 = agent.addNode("chat-1", new ChatCompletionWithTools(), {
  systemPrompt: "You are an amazing AI assistant called Jarvis",
  temperature: 0.9,
  stream: true,
});

const user = agent.addNode("user", new User());

const getWeather = agent.addNode("weather", new GetWeather());

chat1.bind({
  model: input.output.model,
  query: input.output.query,
  tools: [getWeather.schema],
});

error.bind({
  error: chat1.output.error,
});

user.bind({
  markdown: chat1.output.markdown,
  markdownStream: chat1.output.stream,
  ui: user.mergeRenderStreams(getWeather.render, error.render),
});

export { agent };
