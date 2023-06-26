// import { ShowSuggestionRequest } from "../schema/ShowSuggestionRequest";
import { showSuggestion, SuggestionRanges } from "./suggestions";
import { openEditorAndRevealRange, getRightViewColumn } from "./util/vscode";
import { FileEdit } from "../schema/FileEdit";
import { RangeInFile } from "../schema/RangeInFile";
import * as vscode from "vscode";
import {
  acceptSuggestionCommand,
  rejectSuggestionCommand,
} from "./suggestions";
import { debugPanelWebview, setupDebugPanel } from "./debugPanel";
import { FileEditWithFullContents } from "../schema/FileEditWithFullContents";
import fs = require("fs");
import { WebsocketMessenger } from "./util/messenger";
import { decorationManager } from "./decorations";

class IdeProtocolClient {
  private messenger: WebsocketMessenger | null = null;
  private readonly context: vscode.ExtensionContext;
  private readonly _serverUrl: string;

  private _makingEdit = 0;

  private _newMessenger() {
    const messenger = new WebsocketMessenger(this._serverUrl);
    this.messenger = messenger;
    messenger.onMessage((messageType, data) => {
      this.handleMessage(messageType, data);
    });

    return messenger;
  }

  constructor(serverUrl: string, context: vscode.ExtensionContext) {
    this.context = context;
    this._serverUrl = serverUrl;
    this.messenger = this._newMessenger();

    // Setup listeners for any file changes in open editors
    vscode.workspace.onDidChangeTextDocument((event) => {
      if (this._makingEdit === 0) {
        let fileEdits: FileEditWithFullContents[] = event.contentChanges.map(
          (change) => {
            return {
              fileEdit: {
                filepath: event.document.uri.fsPath,
                range: {
                  start: {
                    line: change.range.start.line,
                    character: change.range.start.character,
                  },
                  end: {
                    line: change.range.end.line,
                    character: change.range.end.character,
                  },
                },
                replacement: change.text,
              },
              fileContents: event.document.getText(),
            };
          }
        );
        this.messenger?.send("fileEdits", { fileEdits });
      } else {
        this._makingEdit--;
      }
    });
  }

  async handleMessage(messageType: string, data: any) {
    switch (messageType) {
      case "highlightedCode":
        this.messenger?.send("highlightedCode", {
          highlightedCode: this.getHighlightedCode(),
        });
        break;
      case "workspaceDirectory":
        this.messenger?.send("workspaceDirectory", {
          workspaceDirectory: this.getWorkspaceDirectory(),
        });
        break;
      case "uniqueId":
        this.messenger?.send("uniqueId", {
          uniqueId: this.getUniqueId(),
        });
        break;
      case "getUserSecret":
        this.messenger?.send("getUserSecret", {
          value: await this.getUserSecret(data.key),
        });
        break;
      case "openFiles":
        this.messenger?.send("openFiles", {
          openFiles: this.getOpenFiles(),
        });
        break;
      case "readFile":
        this.messenger?.send("readFile", {
          contents: this.readFile(data.filepath),
        });
        break;
      case "editFile":
        const fileEdit = await this.editFile(data.edit);
        this.messenger?.send("editFile", {
          fileEdit,
        });
        break;
      case "highlightCode":
        this.highlightCode(data.rangeInFile, data.color);
        break;
      case "runCommand":
        this.messenger?.send("runCommand", {
          output: await this.runCommand(data.command),
        });
        break;
      case "saveFile":
        this.saveFile(data.filepath);
        break;
      case "setFileOpen":
        this.openFile(data.filepath);
        // TODO: Close file
        break;
      case "openGUI":
      case "connected":
        break;
      default:
        throw Error("Unknown message type:" + messageType);
    }
  }
  getWorkspaceDirectory() {
    if (!vscode.workspace.workspaceFolders) {
      // Return the home directory
      return process.env.HOME || process.env.USERPROFILE || "/";
    }
    return vscode.workspace.workspaceFolders[0].uri.fsPath;
  }

  getUniqueId() {
    return vscode.env.machineId;
  }

  // ------------------------------------ //
  // On message handlers

  async highlightCode(rangeInFile: RangeInFile, color: string) {
    const range = new vscode.Range(
      rangeInFile.range.start.line,
      rangeInFile.range.start.character,
      rangeInFile.range.end.line,
      rangeInFile.range.end.character
    );
    const editor = await openEditorAndRevealRange(
      rangeInFile.filepath,
      range,
      vscode.ViewColumn.One
    );
    if (editor) {
      const decorationType = vscode.window.createTextEditorDecorationType({
        backgroundColor: color,
        isWholeLine: true,
      });
      editor.setDecorations(decorationType, [range]);

      // Listen for changes to cursor position and then remove the decoration (but keep for at least 2 seconds)
      const allowRemoveHighlight = () => {
        const cursorDisposable = vscode.window.onDidChangeTextEditorSelection(
          (event) => {
            if (event.textEditor.document.uri.fsPath === rangeInFile.filepath) {
              cursorDisposable.dispose();
              editor.setDecorations(decorationType, []);
            }
          }
        );
      };
      setTimeout(allowRemoveHighlight, 2000);
    }
  }

  showSuggestion(edit: FileEdit) {
    // showSuggestion already exists
    showSuggestion(
      edit.filepath,
      new vscode.Range(
        edit.range.start.line,
        edit.range.start.character,
        edit.range.end.line,
        edit.range.end.character
      ),
      edit.replacement
    );
  }

  openFile(filepath: string) {
    // vscode has a builtin open/get open files
    openEditorAndRevealRange(filepath, undefined, vscode.ViewColumn.One);
  }

  async getUserSecret(key: string) {
    // Check if secret already exists in VS Code settings (global)
    let secret = vscode.workspace.getConfiguration("continue").get(key);
    if (typeof secret !== "undefined" && secret !== null) return secret;

    // If not, ask user for secret
    secret = await vscode.window.showInputBox({
      prompt: `Enter secret for ${key}, OR press enter to try for free. You can edit this later in the Continue VS Code settings.`,
      password: true,
    });

    // Add secret to VS Code settings
    vscode.workspace
      .getConfiguration("continue")
      .update(key, secret, vscode.ConfigurationTarget.Global);

    return secret;
  }

  // ------------------------------------ //
  // Initiate Request

  async openGUI(asRightWebviewPanel: boolean = false) {
    // Open the webview panel
  }

  async getSessionId(): Promise<string> {
    await new Promise((resolve, reject) => {
      // Repeatedly try to connect to the server
      const interval = setInterval(() => {
        if (
          this.messenger &&
          this.messenger.websocket.readyState === 1 // 1 => OPEN
        ) {
          clearInterval(interval);
          resolve(null);
        }
      }, 1000);
    });
    const resp = await this.messenger?.sendAndReceive("openGUI", {});
    const sessionId = resp.sessionId;
    console.log("New Continue session with ID: ", sessionId);
    return sessionId;
  }

  acceptRejectSuggestion(accept: boolean, key: SuggestionRanges) {
    if (accept) {
      acceptSuggestionCommand(key);
    } else {
      rejectSuggestionCommand(key);
    }
  }

  // ------------------------------------ //
  // Respond to request

  getOpenFiles(): string[] {
    return vscode.window.visibleTextEditors
      .filter((editor) => {
        return !(
          editor.document.uri.fsPath.endsWith("/1") ||
          (editor.document.languageId === "plaintext" &&
            editor.document.getText() ===
              "accessible-buffer-accessible-buffer-")
        );
      })
      .map((editor) => {
        return editor.document.uri.fsPath;
      });
  }

  saveFile(filepath: string) {
    vscode.window.visibleTextEditors.forEach((editor) => {
      if (editor.document.uri.fsPath === filepath) {
        editor.document.save();
      }
    });
  }

  readFile(filepath: string): string {
    let contents: string | undefined;
    vscode.window.visibleTextEditors.forEach((editor) => {
      if (editor.document.uri.fsPath === filepath) {
        contents = editor.document.getText();
      }
    });
    if (!contents) {
      contents = fs.readFileSync(filepath, "utf-8");
    }
    return contents;
  }

  editFile(edit: FileEdit): Promise<FileEditWithFullContents> {
    return new Promise((resolve, reject) => {
      openEditorAndRevealRange(
        edit.filepath,
        undefined,
        vscode.ViewColumn.One
      ).then((editor) => {
        const range = new vscode.Range(
          edit.range.start.line,
          edit.range.start.character,
          edit.range.end.line,
          edit.range.end.character
        );

        editor.edit((editBuilder) => {
          this._makingEdit += 2; // editBuilder.replace takes 2 edits: delete and insert
          editBuilder.replace(range, edit.replacement);
          resolve({
            fileEdit: edit,
            fileContents: editor.document.getText(),
          });
        });
      });
    });
  }

  getHighlightedCode(): RangeInFile[] {
    // TODO
    let rangeInFiles: RangeInFile[] = [];
    vscode.window.visibleTextEditors.forEach((editor) => {
      editor.selections.forEach((selection) => {
        if (!selection.isEmpty) {
          rangeInFiles.push({
            filepath: editor.document.uri.fsPath,
            range: {
              start: {
                line: selection.start.line,
                character: selection.start.character,
              },
              end: {
                line: selection.end.line,
                character: selection.end.character,
              },
            },
          });
        }
      });
    });
    return rangeInFiles;
  }

  async runCommand(command: string) {
    if (vscode.window.terminals.length) {
      vscode.window.terminals[0].sendText(command);
    } else {
        const terminal = vscode.window.createTerminal();
        terminal.show();
        terminal.sendText(command);
    }
  }

  sendCommandOutput(output: string) {
    this.messenger?.send("commandOutput", { output });
  }
}

export default IdeProtocolClient;
