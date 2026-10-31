/** Imperative methods of react-native-webview (its typings don't expose the ref type). */
export interface WebViewHandle {
  injectJavaScript(js: string): void;
  goBack(): void;
  reload(): void;
}
