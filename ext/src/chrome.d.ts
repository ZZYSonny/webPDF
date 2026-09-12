/**
 * The browser API this extension uses, typed where it is used.
 *
 * Deliberately not `@types/chrome`: the extension touches two dozen members of
 * one API and nothing else, and writing them down here says exactly which ones -
 * every call in `background.ts` and `viewer.ts` is checked against this list, and
 * a member that is not here is a member nobody asked for. It is a declaration
 * file only; nothing is emitted from it and nothing is imported.
 *
 * The signatures are the ones Chrome documents, narrowed to the shapes this code
 * passes: optional where the caller may leave something out, and `Promise` where
 * Chrome 115 and later resolves one instead of taking a callback.
 */

declare namespace chrome {
  namespace runtime {
    interface MessageSender {
      /** The tab the message came from, absent for a message from the worker. */
      tab?: { id?: number; url?: string };
      /** The document that sent it; zero for the tab's own document. */
      frameId?: number;
      url?: string;
      id?: string;
    }

    const id: string;
    function getURL(path: string): string;
    function getManifest(): Record<string, unknown>;
    /** Ask another part of this extension something. */
    function sendMessage<T = unknown>(message: unknown): Promise<T>;
    const onInstalled: { addListener(callback: (details: { reason: string }) => void): void };
    const onStartup: { addListener(callback: () => void): void };
    /** Return true to answer asynchronously through `respond`. */
    const onMessage: {
      addListener(
        callback: (
          message: unknown,
          sender: MessageSender,
          respond: (response?: unknown) => void,
        ) => boolean | undefined | void,
      ): void;
    };
  }

  namespace storage {
    interface StorageArea {
      get(keys?: string | string[] | null): Promise<Record<string, unknown>>;
      set(items: Record<string, unknown>): Promise<void>;
      remove(keys: string | string[]): Promise<void>;
    }
    /** The profile's own small store: survives the worker, and the browser. */
    const local: StorageArea;
  }

  namespace declarativeNetRequest {
    interface Rule {
      id: number;
      priority?: number;
      action: {
        type: 'redirect' | 'block' | 'allow' | 'upgradeScheme' | 'modifyHeaders' | 'allowAllRequests';
        redirect?: { url?: string; extensionPath?: string; regexSubstitution?: string };
      };
      condition: {
        regexFilter?: string;
        urlFilter?: string;
        resourceTypes?: string[];
        isUrlFilterCaseSensitive?: boolean;
      };
    }
    /** Rules stored in the profile: they apply whether or not the worker runs. */
    function updateDynamicRules(options: { removeRuleIds?: number[]; addRules?: Rule[] }): Promise<void>;
    function getDynamicRules(): Promise<Rule[]>;
  }

  namespace webNavigation {
    interface Details {
      tabId: number;
      frameId: number;
      url: string;
      parentFrameId: number;
      /** Set when the navigation came from a redirect. */
      transitionType?: string;
      transitionQualifiers?: string[];
    }
    const onBeforeNavigate: { addListener(callback: (details: Details) => void): void };
    const onCommitted: { addListener(callback: (details: Details) => void): void };
  }

  namespace webRequest {
    interface Header {
      name: string;
      value?: string;
    }
    interface Details {
      tabId: number;
      type: string;
      url: string;
      method: string;
      responseHeaders?: Header[];
    }
    interface Filter {
      urls: string[];
      types?: string[];
    }
    const onHeadersReceived: {
      addListener(
        callback: (details: Details) => void,
        filter: Filter,
        extraInfoSpec?: string[],
      ): void;
    };
  }

  namespace tabs {
    interface Tab {
      id?: number;
      url?: string;
      title?: string;
    }
    function get(tabId: number): Promise<Tab>;
    function update(tabId: number, props: { url?: string; active?: boolean }): Promise<Tab>;
    function create(props: { url?: string; active?: boolean }): Promise<Tab>;
  }

  namespace action {
    const onClicked: { addListener(callback: (tab: tabs.Tab) => void): void };
    function setTitle(details: { title: string }): Promise<void>;
  }

  namespace downloads {
    /** Save a URL the reader asked for as a file: Ctrl+S in the viewer. */
    function download(options: { url: string; filename?: string }): Promise<number>;
  }

  namespace extension {
    /** Whether the reader has let this extension see `file://` URLs. */
    function isAllowedFileSchemeAccess(): Promise<boolean>;
  }
}
