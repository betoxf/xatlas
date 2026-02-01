import * as https from 'https';
import * as http from 'http';
import * as vscode from 'vscode';

/**
 * OpenRouter AI service for generating terminal names
 */
export class OpenRouterService {
  private apiKey: string;
  private model: string;
  private baseUrl: string;

  constructor(apiKey: string, model: string = 'x-ai/grok-4.1-fast') {
    this.apiKey = apiKey;
    this.model = model;
    this.baseUrl = 'openrouter.ai';
  }

  /**
   * Generate a terminal name based on context
   */
  async generateTerminalName(context: TerminalContext): Promise<string> {
    const prompt = this.buildPrompt(context);

    try {
      const response = await this.callOpenRouter(prompt);
      return this.parseNameFromResponse(response);
    } catch (error) {
      console.error('OpenRouterService: Error generating name:', error);
      return context.workingDirectory?.split('/').pop() || 'Terminal';
    }
  }

  /**
   * Build prompt for the AI model
   */
  private buildPrompt(context: TerminalContext): string {
    const parts: string[] = [];

    // Context from working directory
    if (context.workingDirectory) {
      const dirName = context.workingDirectory.split('/').pop();
      parts.push(`Working directory: ${context.workingDirectory}`);
    }

    // Context from recent commands
    if (context.recentCommands.length > 0) {
      parts.push(`Recent commands:\n${context.recentCommands.join('\n')}`);
    }

    // Context from command outputs
    if (context.recentOutputs.length > 0) {
      parts.push(`Command outputs:\n${context.recentOutputs.join('\n---\n')}`);
    }

    // Context from open files
    if (context.openFiles.length > 0) {
      const fileNames = context.openFiles.map(f => f.split('/').pop()).join(', ');
      parts.push(`Open files: ${fileNames}`);
    }

    const fullContext = parts.join('\n\n');

    return `You are a terminal naming assistant. Generate a short, descriptive name (1-3 words maximum) for a terminal based on its context.

Context:
${fullContext}

Rules:
- Return ONLY the name, nothing else
- Use 1-3 words maximum
- Use title case (e.g., "Database Migration", "API Server", "Tests")
- Focus on what the user is working on
- Examples: "Pusher", "Optimizations", "Frontend Build", "Database Setup"

Terminal name:`;
  }

  /**
   * Call OpenRouter API
   */
  private callOpenRouter(prompt: string): Promise<string> {
    return new Promise((resolve, reject) => {
      const data = JSON.stringify({
        model: this.model,
        messages: [
          {
            role: 'user',
            content: prompt,
          },
        ],
        max_tokens: 20,
        temperature: 0.3,
      });

      const options = {
        hostname: this.baseUrl,
        port: 443,
        path: '/api/v1/chat/completions',
        method: 'POST',
        headers: {
          'Content-Type': 'application/json',
          'Authorization': `Bearer ${this.apiKey}`,
          'HTTP-Referer': 'https://github.com/iprado/vscode-mcp-server',
          'X-Title': 'VS Code MCP Server',
        },
      };

      const req = https.request(options, (res) => {
        let body = '';

        res.on('data', (chunk) => {
          body += chunk;
        });

        res.on('end', () => {
          try {
            if (res.statusCode !== 200) {
              reject(new Error(`OpenRouter API returned ${res.statusCode}: ${body}`));
              return;
            }

            const json = JSON.parse(body);
            const content = json.choices?.[0]?.message?.content;

            if (!content) {
              reject(new Error('No content in OpenRouter response'));
              return;
            }

            resolve(content);
          } catch (error) {
            reject(error);
          }
        });
      });

      req.on('error', reject);
      req.write(data);
      req.end();
    });
  }

  /**
   * Parse and clean the name from AI response
   */
  private parseNameFromResponse(response: string): string {
    // Clean up the response
    let name = response.trim();

    // Remove quotes if present
    name = name.replace(/^["']|["']$/g, '');

    // Remove any trailing punctuation
    name = name.replace(/[.!?,;:]$/g, '');

    // Capitalize first letter of each word
    name = name
      .split(' ')
      .map(word => word.charAt(0).toUpperCase() + word.slice(1).toLowerCase())
      .join(' ')
      .trim();

    // Ensure max 3 words
    const words = name.split(' ').filter(w => w.length > 0);
    if (words.length > 3) {
      name = words.slice(0, 3).join(' ');
    }

    // Fallback if name is too short
    if (name.length < 2) {
      return 'Terminal';
    }

    return name;
  }
}

/**
 * Terminal context for name generation
 */
export interface TerminalContext {
  workingDirectory?: string;
  recentCommands: string[];
  recentOutputs: string[];
  openFiles: string[];
}

/**
 * Retrieve API key from macOS Keychain
 */
export async function getApiKeyFromKeychain(): Promise<string | null> {
  return new Promise((resolve) => {
    const proc = require('child_process').spawn('security', [
      'find-generic-password',
      '-s', 'openrouter-api-key',
      '-w'
    ]);

    let output = '';
    let error = '';

    proc.stdout.on('data', (data: Buffer) => {
      output += data.toString();
    });

    proc.stderr.on('data', (data: Buffer) => {
      error += data.toString();
    });

    proc.on('close', (code: number) => {
      if (code === 0 && output.trim()) {
        resolve(output.trim());
      } else {
        console.error('Failed to retrieve API key from keychain:', error);
        resolve(null);
      }
    });
  });
}
