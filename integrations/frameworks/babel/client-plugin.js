import * as t from "@babel/types";

const tranformCreateAgentNode = {
  ObjectMethod(path) {
    if (path.node.key.name != "run") {
      path.skip();
    }
    // make sure run is non-async generator
    path.node.generator = true;
    path.node.async = false;
    const context = path.get("params")[0];
    path.traverse(transformCreateAgentNodeRunMethod, {
      method: path.node,
      contextName: context.node.name,
      context,
      renderCallCount: 0,
    });
  },
};

const transformCreateAgentNodeRunMethod = {
  BlockStatement(path) {
    if (path.parent !== this.method) {
      return;
    }
    const body = path.get("body");
    path.node.body = path.node.body
      .filter((_, index) => {
        let expression = body[index].get("expression");
        const declarations = body[index].get("declarations");
        // Since only `context.render` or `const xyz = context.render`
        // needs to be preserved, filter out other expressions
        if (!expression.node && declarations.length == 0) {
          return false;
        }
        // if it's a var declaration, check the init expression
        if (declarations.length > 0 && !expression.node) {
          expression = declarations[0].get("init");
        }

        const callee = expression.get("callee");
        const isContextRender =
          t.isMemberExpression(callee.node) &&
          t.isIdentifier(callee.node.object, { name: this.contextName }) &&
          t.isIdentifier(callee.node.property, { name: "render" });

        if (!isContextRender) {
          return false;
        }
        const context = callee.get("object");
        return this.context.scope == context.scope;
      })
      .map(({ expression, declarations }) => {
        if (declarations.length > 0) {
          return t.yieldExpression(
            t.arrayExpression([
              // add render id as the first argument
              t.stringLiteral(`render-${this.renderCallCount++}`),
              declarations[0].init.arguments[0],
            ])
          );
        }
        return t.yieldExpression(
          t.arrayExpression([
            // add render id as the first argument
            t.stringLiteral(`render-${this.renderCallCount++}`),
            expression.arguments[0],
          ])
        );
      });
  },
};

function createPlugin() {
  return ({ types: t }) => {
    return {
      visitor: {
        CallExpression(path) {
          const { node, parent } = path;
          if (path.node.callee.name == "createAgentNode") {
            if (parent.type != "VariableDeclarator") {
              throw new Error(
                "expected use of createAgentNode: const x = createAgentNode(...)"
              );
            }
            parent.init = t.objectExpression(
              node.arguments[0].properties.filter((prop, index) => {
                if (prop.key.name == "run") {
                  path.traverse(tranformCreateAgentNode, { run: prop });
                }
                return ["id", "version", "name", "run"].includes(prop.key.name);
              })
            );
          }
        },
      },
    };
  };
}

export default createPlugin;
