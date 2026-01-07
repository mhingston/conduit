export interface IUrlValidator {
    validateUrl(url: string): Promise<{ valid: boolean; message?: string }>;
}
