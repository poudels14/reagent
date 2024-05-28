import {
  Observable,
  filter,
  groupBy,
  map,
  merge,
  mergeMap,
  of,
  reduce,
  share,
  take,
  takeUntil,
  zip,
} from "rxjs";
import { fromError } from "zod-validation-error";

import { Context } from "../context";
import { AbstractAgentNode } from "../node";
import { AgentEvent, EventStream } from "../stream";
import { uniqueId } from "../../utils/uniqueId";

type OutputValueProvider<Output> = Pick<
  Observable<{
    // run is null for run independent global values
    run: {
      id: string;
    } | null;
    value: Output;
  }>,
  "subscribe" | "pipe"
> & {
  /**
   * Select the output result by run id
   *
   * @param runId
   */
  select(options: { runId: string }): Promise<Output>;
};

const VALUE_PROVIDER = Symbol("___VALUE_PROVIDER__");

type RenderUpdate = {
  node: { id: string; type: string; version: string };
  render: {
    step: string;
    data: any;
  };
};

type MappedInputEvent = {
  type: AgentEvent.Type;
  run: { id: string };
  sourceField: string;
  targetField: string;
  isArray: boolean;
  value: any;
};

class GraphNode<
  Config extends Record<string, unknown> | void,
  Input extends Record<string, unknown>,
  Output extends Record<string, unknown>,
  State extends Record<string, unknown> = {},
> {
  #nodeId: string;
  #node: AbstractAgentNode<Config, Input, Output, State>;
  #config: Config;
  #stream: EventStream<Output>;
  // this is used to cache the output stream by field to void
  // duplicate filtering/computation when same output field
  // is used more than once
  #_outputStreams: Record<string, any>;
  #_renderStream: any;
  // This is "phantom" field only used for type inference
  _types: { output: Output };

  constructor(
    nodeId: string,
    node: AbstractAgentNode<Config, Input, Output, State>,
    config: Config,
    stream: EventStream<Output>
  ) {
    this.#nodeId = nodeId;
    this.#node = node;
    this.#config = config;
    this.#stream = stream;
    this.#node.init(
      this.#buildContext({
        // runId when initializing will be different than when running
        id: "__NODE_INIT__",
      })
    );
    this.#_outputStreams = {};
    // @ts-expect-error
    this._types = undefined;
  }

  bind(edges: {
    [K in keyof Input]: Input[K] extends OutputValueProvider<Input[K]>
      ? OutputValueProvider<Input[K]>
      : Required<Input>[K] extends any[]
        ? OutputValueProvider<Required<Input>[K][number]>[]
        : OutputValueProvider<Required<Input>[K]> | Required<Input>[K];
  }) {
    const self = this;
    const allProviders = Object.entries(edges);
    const providers = allProviders.flatMap(([targetField, provider]: any) => {
      if (Array.isArray(provider)) {
        return provider.map((p) => {
          return {
            targetField,
            ...p[VALUE_PROVIDER],
            provider: p,
          };
        });
      }
      return [
        {
          targetField,
          ...provider[VALUE_PROVIDER],
          provider,
        },
      ];
    });

    const outputSourceProviders = providers.filter((p) => p.type == "output");
    const uniqueOutputProviderNodes = new Set(
      outputSourceProviders.map((p) => p.node.id)
    );

    const schemaSources = providers.filter((p) => p.type == "schema");
    const renderSources = providers.filter((p) => p.type == "render");

    self.#stream.pipe(groupBy((e) => e.run.id)).subscribe((group) => {
      const outputProvidersCompleted = group
        .pipe(
          filter((e) => {
            return (
              (e.type == AgentEvent.Type.RunCompleted ||
                e.type == AgentEvent.Type.RunSkipped) &&
              uniqueOutputProviderNodes.has(e.node.id)
            );
          })
        )
        .pipe(take(uniqueOutputProviderNodes.size))
        .pipe(share());

      const outputProviderStream = group
        .pipe(
          filter((e) => {
            return (
              e.type == AgentEvent.Type.Output &&
              uniqueOutputProviderNodes.has(e.node.id)
            );
          })
        )
        .pipe(
          mergeMap((e: any) => {
            const fieldMappings = Object.fromEntries(
              outputSourceProviders
                .filter((n) => {
                  return n.node.id == e.node.id;
                })
                .map((n) => {
                  return [n.sourceField, n.targetField];
                })
            );
            // emit event for each output key used by the node
            return of<MappedInputEvent[]>(
              ...Object.entries(e.output)
                .filter(([sourceField]) => fieldMappings[sourceField])
                .map(([sourceField, value]) => {
                  const targetField = fieldMappings[sourceField];
                  return {
                    type: e.type,
                    run: e.run,
                    node: e.node,
                    sourceField,
                    targetField,
                    isArray: Array.isArray(edges[targetField]),
                    value,
                  };
                })
            );
          })
        )
        .pipe(takeUntil(outputProvidersCompleted))
        .pipe(take(outputSourceProviders.length))
        .pipe(share());

      const schemaProviderStream = group
        .pipe(filter((e) => e.type == AgentEvent.Type.RunInvoked))
        .pipe(take(1))
        .pipe(
          mergeMap((e) => {
            return merge<MappedInputEvent[]>(
              ...schemaSources.map(({ targetField, provider }) => {
                return provider.pipe(take(1)).pipe(
                  map((schema) => {
                    return {
                      type: "node/schema",
                      run: e.run,
                      sourceField: "schema",
                      targetField,
                      isArray: Array.isArray(edges[targetField]),
                      value: schema,
                    };
                  })
                );
              })
            );
          })
        )
        .pipe(take(schemaSources.length))
        .pipe(share());

      const renderStream = group
        .pipe(filter((e) => e.type == AgentEvent.Type.RunInvoked))
        .pipe(take(1))
        .pipe(
          mergeMap((e) => {
            return merge<MappedInputEvent[]>(
              ...renderSources.map(({ targetField, provider }) =>
                provider.pipe(
                  filter((pe: any) => {
                    return pe.run.id == e.run.id;
                  }),
                  map((pe: any) => {
                    return {
                      type: "node/render",
                      run: e.run,
                      sourceField: "__render__",
                      targetField,
                      isArray: Array.isArray(edges[targetField]),
                      value: pe.value,
                    };
                  })
                )
              )
            );
          })
        )
        .pipe(take(renderSources.length))
        .pipe(share());

      const schemaSourceNodeIds = new Set(schemaSources.map((s) => s.node.id));
      // trigger when this current node is completed/skipped
      const nodeCompleted = group
        .pipe(
          filter(
            (e) =>
              e.node.id == self.#nodeId &&
              (e.type == AgentEvent.Type.RunCompleted ||
                e.type == AgentEvent.Type.RunSkipped)
          )
        )
        .pipe(take(1));

      const schemaNodesRunStream = group
        .pipe(takeUntil(nodeCompleted))
        .pipe(
          filter(
            (e) =>
              (e.type == AgentEvent.Type.RunCompleted ||
                e.type == AgentEvent.Type.RunSkipped) &&
              schemaSourceNodeIds.has(e.node.id)
          )
        )
        .pipe(
          reduce((agg, cur) => {
            agg.add(cur.node.id);
            return agg;
          }, new Set())
        );

      // trigger run skipped for nodes whose schema is bound
      zip(nodeCompleted, schemaNodesRunStream).subscribe(
        ([runComplete, schemaNodesThatWasRun]) => {
          [...schemaSourceNodeIds].forEach((nodeId) => {
            if (!schemaNodesThatWasRun.has(nodeId)) {
              const schemaSource = schemaSources.find(
                (s) => s.node.id == nodeId
              );
              self.#stream.next({
                type: AgentEvent.Type.RunSkipped,
                run: runComplete.run,
                node: schemaSource.node,
              });
            }
          });
        }
      );

      // group events by target field and emit input events
      merge(outputProviderStream, schemaProviderStream, renderStream)
        .pipe(groupBy((e) => e.targetField))
        .subscribe({
          next(group) {
            group
              // idk why this is needed even though I assume group
              // will be completed when input streams are completed
              // but maybe mergeing completed stream doesn't close
              // down stream observable :shrug:
              .pipe(
                take(
                  Array.isArray(edges[group.key])
                    ? (edges[group.key] as any).length
                    : 1
                )
              )
              .pipe(inputReducer())
              .subscribe((e) => {
                const context = self.#buildContext(e.run);
                if (e.count > 0) {
                  self.#node.onInputEvent(context, e.input);
                }
              });
          },
          complete() {},
          error(_err) {},
        });

      // merge all inputs and invoke the step
      zip(
        outputProvidersCompleted,
        merge(outputProviderStream, schemaProviderStream, renderStream).pipe(
          inputReducer()
        )
      ).subscribe({
        next([runCompleteEvent, inputEvent]) {
          if (
            inputEvent.count ==
            outputSourceProviders.length +
              schemaSources.length +
              renderSources.length
          ) {
            self.#invoke(inputEvent.input, inputEvent.run);
          } else {
            // if all output provider nodes are completed but all expected inputs
            // weren't received, emit node skipped event
            self.#stream.next({
              type: AgentEvent.Type.RunSkipped,
              run: runCompleteEvent.run,
              node: {
                id: self.#nodeId,
                type: self.#node.metadata.id,
                version: self.#node.metadata.version,
              },
            });
          }
        },
        complete() {},
        error(_err) {},
      });
    });
  }

  invoke(input: Input, options: { run?: { id: string } } = {}) {
    const run = {
      id: options.run?.id || uniqueId(),
    };
    const self = this;
    if (!options.run?.id) {
      this.#stream.next({
        type: AgentEvent.Type.RunInvoked,
        node: {
          id: self.#nodeId,
          type: self.#node.metadata.id,
          version: self.#node.metadata.version,
        },
        run,
      });
    }
    const output = this.#invoke(input, run);
    return { run, output };
  }

  /**
   * Returns schema to use this node as a tool in LLM call
   *
   * Note: This should only be used to bind to a node input
   * and shouldn't be used directly
   */
  get schema(): OutputValueProvider<{
    id: string;
    name: string;
    description: string;
    parameters: Record<string, any>;
    node: GraphNode<Config, Input, Output>;
  }> {
    const self = this;
    const metadata = this.#node.metadata;
    const stream = of({
      id: metadata.id,
      name: metadata.name,
      description: metadata.description!,
      get parameters() {
        return metadata.input;
      },
      node: self,
    });

    // @ts-expect-error
    return Object.defineProperty(stream, VALUE_PROVIDER, {
      value: {
        type: "schema",
        node: {
          id: self.#nodeId,
          type: self.#node.metadata.id,
          version: self.#node.metadata.version,
        },
      },
      enumerable: false,
      writable: false,
      configurable: false,
    });
  }

  get output(): {
    [K in keyof Output]: OutputValueProvider<Output[K]>;
  } {
    const self = this;
    // @ts-expect-error
    return new Proxy(
      {},
      {
        get(_, field: string) {
          let stream = self.#_outputStreams[field];
          if (stream) {
            return stream;
          }
          stream = self.#stream
            .pipe(
              filter(
                (e: any) =>
                  e.type == AgentEvent.Type.Output &&
                  e.node.id == self.#nodeId &&
                  field in e.output
              )
            )
            .pipe(
              map((e) => {
                return { run: e.run, field, value: e.output[field] };
              })
            );

          Object.defineProperties(stream, {
            [VALUE_PROVIDER]: {
              value: {
                type: "output",
                node: {
                  id: self.#nodeId,
                  type: self.#node.metadata.id,
                  version: self.#node.metadata.version,
                },
                sourceField: field,
              },
              configurable: false,
              enumerable: false,
              writable: false,
            },
            select: {
              value: (options: { runId: string }) => {
                return new Promise((resolve) => {
                  stream
                    .pipe(filter((e: any) => e.run.id == options.runId))
                    .subscribe((e: any) => {
                      resolve(e.value);
                    });
                });
              },
              enumerable: false,
            },
          });
          self.#_outputStreams[field] = stream;
          return stream;
        },
      }
    );
  }

  /**
   * Merges two streams into one
   *
   * If a node has a stream input but need to take in stream
   * from more than one output/render, then this can be used to combine the
   * streams;
   *
   * For example:
   * ```
   * user.mergeRenderStreams(error.render, getWeather.render),
   * ```
   *
   * @param renders
   * @returns
   */
  mergeRenderStreams<O>(
    ...renders: OutputValueProvider<O>[]
  ): OutputValueProvider<O> {
    // @ts-expect-error
    const stream = merge(...renders)
      .pipe(groupBy((e: any) => e.run.id))
      .pipe(
        map((group) => {
          const value = group
            .pipe(take(renders.length))
            .pipe(mergeMap((g) => g.value))
            .pipe(share());

          // TODO: removing this doesn't stream render events; BUT WHY?
          value.subscribe();
          return {
            run: {
              id: group.key,
            },
            value,
          };
        })
      )
      .pipe(share());

    return Object.defineProperties(stream, {
      [VALUE_PROVIDER]: {
        value: {
          type: "render",
        },
        configurable: false,
        enumerable: false,
        writable: false,
      },
    }) as unknown as OutputValueProvider<O>;
  }

  /**
   * Note: This should only be used to bind to a node input
   * and shouldn't be used directly
   */
  // TODO: if render stream is used, make sure the node's schema
  // is also bound; otherwise, the render stream won't close
  get render(): OutputValueProvider<Observable<RenderUpdate>> {
    const self = this;
    if (self.#_renderStream) {
      return self.#_renderStream;
    }
    const stream = self.#stream
      .pipe(
        filter(
          (e: any) =>
            // filter either any run invoked events or events for this node
            e.node.id == self.#nodeId || e.type == AgentEvent.Type.RunInvoked
        )
      )
      .pipe(groupBy((e) => e.run.id))
      .pipe(
        map((group) => {
          const runCompleted = group.pipe(
            filter(
              (e) =>
                e.type == AgentEvent.Type.RunCompleted ||
                e.type == AgentEvent.Type.RunSkipped
            )
          );

          // TODO: removing this doesn't stream render events; BUT WHY?
          group.subscribe((x) => {});
          return {
            run: {
              id: group.key,
            },
            value: group
              .pipe(takeUntil(runCompleted))
              .pipe(filter((e) => e.type == AgentEvent.Type.Render)),
          };
        })
      )
      .pipe(share());

    Object.defineProperties(stream, {
      [VALUE_PROVIDER]: {
        value: {
          type: "render",
        },
        configurable: false,
        enumerable: false,
        writable: false,
      },
      select: {
        value: (options: { runId: string }) => {
          return new Promise((resolve) => {
            stream
              .pipe(filter((e: any) => e.run.id == options.runId))
              .subscribe((e: any) => {
                resolve(e.value);
              });
          });
        },
        enumerable: false,
      },
    });

    self.#_renderStream = stream;
    return stream as unknown as OutputValueProvider<Observable<RenderUpdate>>;
  }

  async #invoke(input: Input, run: { id: string }): Promise<Output> {
    const context = this.#buildContext(run);
    // const validation = this.#node.metadata.input.safeParse(input);
    // if (!validation.success) {
    //   throw new Error(
    //     `[node=${this.#node.metadata.id}]: ${fromError(validation.error)}`
    //   );
    // }
    const node = {
      id: this.#nodeId,
      type: this.#node.metadata.id,
      version: this.#node.metadata.version,
    };
    const generator = this.#node.execute(context, input);
    const output = {};
    for await (const partialOutput of generator) {
      this.#stream.sendOutput({
        run,
        node,
        output: partialOutput,
      });
      Object.assign(output, partialOutput);
    }
    this.#stream.next({
      type: AgentEvent.Type.RunCompleted,
      run,
      node,
    });
    return output as Output;
  }

  #buildContext(run: Context<any, any>["run"]): Context<any, any> {
    const self = this;
    return {
      run,
      node: {
        id: self.#nodeId,
      },
      config: this.#config || {},
      sendOutput(output: Output) {
        self.#stream.sendOutput({
          run,
          node: {
            id: self.#nodeId,
            type: self.#node.metadata.id,
            version: self.#node.metadata.version,
          },
          output,
        });
      },
      render(step, data) {
        // since this runs in server side, render will be transpiled to only pass component id
        const stepId = step as unknown as string;
        const node = {
          id: self.#nodeId,
          type: self.#node.metadata.id,
          version: self.#node.metadata.version,
        };
        self.#stream.sendRenderUpdate({
          run,
          node,
          update: {
            step: stepId,
            data,
          },
        });
        return {
          update(data) {
            self.#stream.sendRenderUpdate({
              run,
              node,
              update: {
                step: stepId,
                data,
              },
            });
          },
        };
      },
    };
  }
}

const inputReducer = () =>
  reduce<{ run: any; targetField: string; isArray: boolean; value: any }, any>(
    (acc, cur) => {
      // Note: ignore undefined values
      if (cur.value == undefined) {
        return acc;
      }
      if (acc.run?.id) {
        // run is null for global events
        // so only throw error if run id doesn't match for run events
        if (cur.run != null && acc.run.id != cur.run.id) {
          throw new Error(`unexpected error: run is must match`);
        }
      } else if (cur.run != null) {
        acc["run"] = cur.run;
      }

      if (acc.input[cur.targetField] == undefined) {
        // if there's more than one value for a given key,
        // reduce them to an array
        acc.input[cur.targetField] = cur.isArray ? [cur.value] : cur.value;
      } else {
        if (!cur.isArray) {
          throw new Error(
            `Unexpected error: got more than 1 value when only 1 is expected`
          );
        }
        acc.input[cur.targetField].push(cur.value);
      }
      acc.count += 1;
      return acc;
    },
    {
      input: {},
      run: null,
      count: 0,
    } as any
  );

export { GraphNode };
export type { OutputValueProvider };
