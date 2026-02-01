import {
  MCPRequest,
  MCPResponse,
  MCPTool,
  MCPErrorCodes,
  ToolCallParams,
  ToolResult,
  ToolHandler,
} from '../types';
import { actionLog } from '../services/actionLog';

// Server info
const SERVER_INFO = {
  name: 'vscode-mcp-server',
  version: '0.1.0',
};

// Protocol version
const PROTOCOL_VERSION = '2024-11-05';

// Tool registry
const tools: Map<string, { definition: MCPTool; handler: ToolHandler }> = new Map();

/**
 * Register a tool with the MCP server
 */
export function registerTool(definition: MCPTool, handler: ToolHandler): void {
  tools.set(definition.name, { definition, handler });
  console.log(`Registered tool: ${definition.name}`);
}

/**
 * Get all registered tools
 */
export function getTools(): MCPTool[] {
  return Array.from(tools.values()).map(t => t.definition);
}

/**
 * Handle an MCP request
 */
export async function handleMCPRequest(request: MCPRequest): Promise<MCPResponse> {
  const { id, method, params } = request;

  try {
    switch (method) {
      case 'initialize':
        return {
          jsonrpc: '2.0',
          id,
          result: {
            protocolVersion: PROTOCOL_VERSION,
            serverInfo: SERVER_INFO,
            capabilities: {
              tools: {},
            },
          },
        };

      case 'initialized':
        return {
          jsonrpc: '2.0',
          id,
          result: {},
        };

      case 'tools/list':
        return {
          jsonrpc: '2.0',
          id,
          result: {
            tools: getTools(),
          },
        };

      case 'tools/call':
        const toolParams = params as ToolCallParams;
        if (!toolParams?.name) {
          return {
            jsonrpc: '2.0',
            id,
            error: {
              code: MCPErrorCodes.INVALID_PARAMS,
              message: 'Missing tool name',
            },
          };
        }

        const tool = tools.get(toolParams.name);
        if (!tool) {
          actionLog.logAction(
            toolParams.name,
            toolParams.arguments || {},
            null,
            `Tool not found: ${toolParams.name}`,
            'mcp'
          );
          return {
            jsonrpc: '2.0',
            id,
            error: {
              code: MCPErrorCodes.METHOD_NOT_FOUND,
              message: `Tool not found: ${toolParams.name}`,
            },
          };
        }

        // Log action start
        const actionId = actionLog.startAction(
          toolParams.name,
          toolParams.arguments || {},
          'mcp'
        );

        try {
          const result = await tool.handler(toolParams.arguments || {});
          // Log success
          actionLog.completeAction(actionId, result);
          return {
            jsonrpc: '2.0',
            id,
            result,
          };
        } catch (error) {
          const errorMsg = error instanceof Error ? error.message : 'Unknown error';
          // Log error
          actionLog.completeAction(actionId, null, errorMsg);
          const errorResult: ToolResult = {
            content: [
              {
                type: 'text',
                text: `Error: ${errorMsg}`,
              },
            ],
            isError: true,
          };
          return {
            jsonrpc: '2.0',
            id,
            result: errorResult,
          };
        }

      case 'ping':
        return {
          jsonrpc: '2.0',
          id,
          result: {},
        };

      default:
        return {
          jsonrpc: '2.0',
          id,
          error: {
            code: MCPErrorCodes.METHOD_NOT_FOUND,
            message: `Method not found: ${method}`,
          },
        };
    }
  } catch (error) {
    return {
      jsonrpc: '2.0',
      id,
      error: {
        code: MCPErrorCodes.INTERNAL_ERROR,
        message: error instanceof Error ? error.message : 'Internal error',
      },
    };
  }
}
