export const BRAND_NAME = 'xatlas';
export const CONFIG_NAMESPACE = 'xerebro';
export const SERVER_NAME = 'xerebro';

let extensionId = 'xerebro.xerebro-vscode';

export function setExtensionId(id: string): void {
  extensionId = id;
}

export function getExtensionId(): string {
  return extensionId;
}
