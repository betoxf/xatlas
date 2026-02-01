import * as vscode from 'vscode';
import { BRAND_NAME, CONFIG_NAMESPACE } from './extensionInfo';

const LICENSE_STORAGE_KEY = 'xerebro.licenseKey';
const ENV_LICENSE_KEY = 'XEREBRO_LICENSE_KEY';
const ENV_API_KEY = 'XEREBRO_API_KEY';
const FREE_PROJECT_LIMIT = 30;
const BILLING_URL = 'https://xerebro.ai/pricing';

export class LicenseService {
  private static instance: LicenseService;
  private context?: vscode.ExtensionContext;
  private cachedKey?: string | null;

  public static getInstance(): LicenseService {
    if (!LicenseService.instance) {
      LicenseService.instance = new LicenseService();
    }
    return LicenseService.instance;
  }

  public initialize(context: vscode.ExtensionContext): void {
    this.context = context;
  }

  public async hasPremium(): Promise<boolean> {
    const key = await this.getLicenseKey();
    return Boolean(key && this.isValidKey(key));
  }

  public async requirePremium(featureName: string): Promise<boolean> {
    if (await this.hasPremium()) {
      return true;
    }

    const choice = await vscode.window.showWarningMessage(
      `${featureName} requires a ${BRAND_NAME} Pro license.`,
      'Enter License',
      'Get License'
    );

    if (choice === 'Enter License') {
      await this.promptForLicense();
      return this.hasPremium();
    }

    if (choice === 'Get License') {
      vscode.env.openExternal(vscode.Uri.parse(BILLING_URL));
    }

    return false;
  }

  public async canAddProject(existingTrackedCount: number): Promise<boolean> {
    if (this.isBusinessUsage()) {
      return this.requirePremium('Business use');
    }
    if (existingTrackedCount < FREE_PROJECT_LIMIT) {
      return true;
    }
    return this.requirePremium('30+ projects');
  }

  private isBusinessUsage(): boolean {
    const value = vscode.workspace
      .getConfiguration(CONFIG_NAMESPACE)
      .get<string>('usageType', 'personal');
    return value === 'business';
  }

  public async promptForLicense(): Promise<boolean> {
    const input = await vscode.window.showInputBox({
      prompt: `${BRAND_NAME} license key`,
      placeHolder: 'XER-XXXX-XXXX-XXXX',
      ignoreFocusOut: true,
      password: true,
    });

    if (!input) {
      return false;
    }

    const trimmed = input.trim();
    if (!this.isValidKey(trimmed)) {
      vscode.window.showErrorMessage('That license key format looks invalid.');
      return false;
    }

    if (!this.context) {
      vscode.window.showErrorMessage('License storage not initialized.');
      return false;
    }

    await this.context.secrets.store(LICENSE_STORAGE_KEY, trimmed);
    this.cachedKey = trimmed;
    vscode.window.showInformationMessage(`${BRAND_NAME} license saved.`);
    return true;
  }

  private async getLicenseKey(): Promise<string | null> {
    if (this.cachedKey !== undefined) {
      return this.cachedKey;
    }

    const envKey = process.env[ENV_LICENSE_KEY] || process.env[ENV_API_KEY];
    if (envKey && envKey.trim()) {
      this.cachedKey = envKey.trim();
      return this.cachedKey;
    }

    if (this.context) {
      const stored = await this.context.secrets.get(LICENSE_STORAGE_KEY);
      if (stored) {
        this.cachedKey = stored;
        return stored;
      }
    }

    const configKey = vscode.workspace
      .getConfiguration(CONFIG_NAMESPACE)
      .get<string>('apiKey');
    if (configKey && configKey.trim()) {
      this.cachedKey = configKey.trim();
      return this.cachedKey;
    }

    this.cachedKey = null;
    return null;
  }

  private isValidKey(value: string): boolean {
    if (!value) {
      return false;
    }
    const upper = value.toUpperCase();
    if (/^XER-[A-Z0-9]{4}-[A-Z0-9]{4}-[A-Z0-9]{4}$/.test(upper)) {
      return true;
    }
    if (/^XEREBRO-[A-Z0-9-]{10,}$/.test(upper)) {
      return true;
    }
    return value.length >= 20;
  }
}
