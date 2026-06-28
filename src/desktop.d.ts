export {};

declare global {
  interface Window {
    highlightAI?: {
      chooseFolder: () => Promise<string | null>;
      showItemInFolder: (filePath: string) => Promise<boolean>;
    };
  }
}
