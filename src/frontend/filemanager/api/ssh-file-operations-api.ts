import type { FileItem } from "../host-types";
import {
  getCachedFileList,
  getFileListEpoch,
} from "../lib/file-list-request-cache";
import {
  getCachedFileContent,
  invalidateCachedFileContent,
  type FileContentResult,
} from "../lib/file-content-request-cache";
import { downloadUrl } from "../../app";
import {
  AdbConnectError,
  clientFor,
  closeSession,
  isConnected,
  openSession,
  toFileItem,
} from "./adb-session";
import { joinPath, parentPath } from "../../files-utils";

/**
 * The calls the file manager makes, answered over the device's /files socket.
 * The names and shapes follow the Termix file manager; there is no SSH
 * session here, the "session id" is the host id.
 */

export interface SSHConnectResult {
  success?: boolean;
  status?: string;
  reason?: "timeout" | "no_keyboard" | "auth_failed";
  requires_totp?: boolean;
  requires_browser_sign_in?: boolean;
  sessionId?: string;
  prompt?: string;
  url?: string;
  code?: string;
  label?: string;
}

export async function connectSSH(
  sessionId: string,
  config: { hostId?: number } & Record<string, unknown>,
): Promise<SSHConnectResult> {
  await openSession(sessionId, String(config.hostId ?? sessionId));
  return { success: true, status: "connected", sessionId };
}

export async function verifySSHTOTP(
  _sessionId: string,
  _totpCode: string,
): Promise<Record<string, unknown>> {
  return {};
}

export async function verifySSHBrowserSignIn(
  _sessionId: string,
): Promise<Record<string, unknown>> {
  return {};
}

export async function getSSHStatus(
  sessionId: string,
): Promise<{ connected: boolean }> {
  return { connected: isConnected(sessionId) };
}

export async function keepSSHAlive(
  sessionId: string,
): Promise<Record<string, unknown>> {
  if (!isConnected(sessionId)) throw new Error("Not connected");
  return {};
}

export function disconnectSSH(sessionId: string): void {
  closeSession(sessionId);
}

export async function listSSHFiles(
  sessionId: string,
  path: string,
  options: { force?: boolean; prefetch?: boolean } = {},
): Promise<{ files: FileItem[]; path: string }> {
  const epoch = getFileListEpoch(sessionId);
  void epoch;
  return getCachedFileList(
    sessionId,
    path,
    async () => {
      const reply = await clientFor(sessionId).call("list", { path });
      return {
        path,
        files: (reply.entries ?? []).map((entry) => toFileItem(path, entry)),
      };
    },
    options.force,
  );
}

export async function identifySSHSymlink(
  sessionId: string,
  path: string,
): Promise<{ path: string; target: string; type: "directory" | "file" }> {
  const reply = await clientFor(sessionId).call("stat", { path });
  return {
    path,
    target: path,
    type: reply.entry?.dir ? "directory" : "file",
  };
}

export async function resolveSSHPath(
  sessionId: string,
  path: string,
): Promise<string> {
  const reply = await clientFor(sessionId).call("stat", { path });
  if (!reply.entry) throw new Error("No such file or folder");
  return path;
}

export async function readSSHFile(
  sessionId: string,
  path: string,
  options: { force?: boolean } = {},
): Promise<FileContentResult> {
  return getCachedFileContent(
    sessionId,
    path,
    async () => {
      const client = clientFor(sessionId);
      try {
        const { content } = await client.readText(path);
        return { content, path };
      } catch (error) {
        // Not text: hand it over as base64 for the image, audio and PDF views.
        const message = error instanceof Error ? error.message : "";
        if (!/not a text file/i.test(message)) throw error;
        const reply = await client.call("readbin", { path });
        return { content: reply.content ?? "", path, encoding: "base64" };
      }
    },
    options.force,
  );
}

export async function writeSSHFile(
  sessionId: string,
  path: string,
  content: string,
  _hostId?: number,
  _userId?: string,
): Promise<Record<string, unknown>> {
  await clientFor(sessionId).writeText(path, content);
  invalidateCachedFileContent(sessionId, path);
  return { success: true };
}

export async function uploadSSHFile(
  sessionId: string,
  path: string,
  fileName: string,
  file: File,
  _hostId?: number,
  _userId?: string,
  onChunkProgress?: (progress: {
    chunkIndex: number;
    totalChunks: number;
    bytesSent: number;
    totalBytes: number;
  }) => void,
  signal?: AbortSignal,
  overwrite = true,
  _uploadRoot?: string,
): Promise<Record<string, unknown>> {
  const client = clientFor(sessionId);
  const target = joinPath(path, fileName);
  if (!overwrite && (await client.exists(target))) {
    throw new Error(`${fileName} already exists there`);
  }
  const parent = parentPath(target);
  if (parent !== path) await client.call("mkdir", { path: parent });
  const total = Math.max(1, Math.ceil(file.size / (256 * 1024)));
  const { id, result } = client.upload(target, file, (done) => {
    onChunkProgress?.({
      chunkIndex: Math.min(total - 1, Math.floor(done / (256 * 1024))),
      totalChunks: total,
      bytesSent: done,
      totalBytes: file.size,
    });
  });
  const abort = () => client.cancel(id);
  signal?.addEventListener("abort", abort, { once: true });
  try {
    await result;
  } finally {
    signal?.removeEventListener("abort", abort);
  }
  return { success: true };
}

export interface DownloadedSSHFile {
  /** base64-encoded file contents */
  content: string;
  fileName: string;
  size: number;
  mimeType: string;
  path: string;
}

export async function downloadSSHFile(
  sessionId: string,
  filePath: string,
  _hostId?: number,
  _userId?: string,
): Promise<DownloadedSSHFile> {
  const reply = await clientFor(sessionId).call("readbin", { path: filePath });
  return {
    content: reply.content ?? "",
    fileName: filePath.split("/").pop() || "file",
    size: reply.size ?? 0,
    mimeType: "application/octet-stream",
    path: filePath,
  };
}

export interface DownloadProgressEvent {
  loaded: number;
  total?: number;
}

/** Downloads go through a one time link the browser follows itself. */
export async function downloadSSHFileStream(
  sessionId: string,
  filePath: string,
  _onProgress?: (event: DownloadProgressEvent) => void,
  _signal?: AbortSignal,
): Promise<void> {
  const reply = await clientFor(sessionId).downloadTicket([filePath]);
  const href = await downloadUrl(reply.ticket);
  if (!href) throw new Error("The server did not give a download link");
  const anchor = document.createElement("a");
  anchor.href = href;
  anchor.download = reply.name;
  anchor.style.display = "none";
  document.body.appendChild(anchor);
  anchor.click();
  anchor.remove();
}

export async function createSSHFile(
  sessionId: string,
  path: string,
  fileName: string,
  _content: string = "",
  _hostId?: number,
  _userId?: string,
): Promise<Record<string, unknown>> {
  await clientFor(sessionId).call("newfile", {
    path: joinPath(path, fileName),
  });
  return { success: true };
}

export async function createSSHFolder(
  sessionId: string,
  path: string,
  folderName: string,
  _hostId?: number,
  _userId?: string,
  _uploadRoot?: string,
): Promise<Record<string, unknown>> {
  await clientFor(sessionId).call("mkdir", {
    path: joinPath(path, folderName),
  });
  return { success: true };
}

export async function deleteSSHItem(
  sessionId: string,
  path: string,
  _isDirectory: boolean,
  _hostId?: number,
  _userId?: string,
  _permanent = false,
): Promise<Record<string, unknown>> {
  await clientFor(sessionId).call("delete", { paths: [path] });
  invalidateCachedFileContent(sessionId, path);
  return { success: true };
}

export interface TrashBatchResult {
  path: string;
  error?: string;
  needsSudo?: boolean;
}

/** Moves paths to the device's trash folder, or deletes them for good. */
export async function trashSSHItems(
  sessionId: string,
  paths: string[],
  opts: { permanent?: boolean; opId?: string; directories?: string[] } = {},
): Promise<TrashBatchResult[]> {
  const reply = await clientFor(sessionId).call("trash", {
    paths,
    permanent: opts.permanent === true,
  });
  for (const p of paths) invalidateCachedFileContent(sessionId, p);
  const byPath = new Map<string, TrashBatchResult>(
    (reply.results ?? []).map((r) => [r.path, r]),
  );
  return paths.map(
    (p) => byPath.get(p) ?? { path: p, error: "No result from the device" },
  );
}

export interface TrashItem {
  id: string;
  name: string;
  originalPath: string;
  isDirectory: boolean;
  deletedAt: string;
  size: number;
}

export async function getSSHTrash(sessionId: string): Promise<{
  items: TrashItem[];
  retentionDays: number;
  canManageRetention: boolean;
}> {
  const reply = await clientFor(sessionId).call("trashList");
  return (
    reply.trash ?? { items: [], retentionDays: 7, canManageRetention: true }
  );
}

export async function restoreSSHTrashItem(sessionId: string, id: string) {
  await clientFor(sessionId).call("trashRestore", { path: id });
}

export async function permanentlyDeleteSSHTrashItem(
  sessionId: string,
  id: string,
) {
  await clientFor(sessionId).call("trashDelete", { path: id });
}

export async function emptySSHTrash(sessionId: string) {
  await clientFor(sessionId).call("trashEmpty");
}

export async function updateSSHTrashRetention(
  sessionId: string,
  retentionDays: number,
) {
  await clientFor(sessionId).call("trashRetention", { size: retentionDays });
}

export async function cancelDeleteItems(
  _sessionId: string,
  _opId: string,
): Promise<void> {
  return;
}

export async function setSudoPassword(
  _sessionId: string,
  _password: string,
): Promise<void> {
  return;
}

export interface CopySSHItemResult {
  message?: string;
  uniqueName?: string;
  targetPath?: string;
}

export async function copySSHItem(
  sessionId: string,
  sourcePath: string,
  targetDir: string,
  _hostId?: number,
  _userId?: string,
  destination?: { name: string; overwrite: boolean },
): Promise<CopySSHItemResult> {
  const client = clientFor(sessionId);
  const name = destination?.name ?? sourcePath.split("/").pop() ?? "copy";
  const to = joinPath(targetDir, name);
  await client.call("copy", {
    from: sourcePath,
    to,
    overwrite: destination?.overwrite === true,
  });
  return { targetPath: to, uniqueName: name };
}

export async function renameSSHItem(
  sessionId: string,
  oldPath: string,
  newName: string,
  _hostId?: number,
  _userId?: string,
): Promise<Record<string, unknown>> {
  await clientFor(sessionId).call("rename", {
    from: oldPath,
    to: joinPath(parentPath(oldPath), newName),
  });
  return { success: true };
}

export async function moveSSHItem(
  sessionId: string,
  oldPath: string,
  newPath: string,
  _hostId?: number,
  _userId?: string,
  overwrite = false,
): Promise<Record<string, unknown>> {
  await clientFor(sessionId).call("rename", {
    from: oldPath,
    to: newPath,
    overwrite,
  });
  return { success: true };
}

export async function changeSSHPermissions(
  sessionId: string,
  path: string,
  permissions: string,
  _hostId?: number,
  _userId?: string,
): Promise<{ success: boolean; message: string }> {
  await clientFor(sessionId).chmod(path, permissions);
  return { success: true, message: "Permissions changed" };
}

export type ArchiveExtractionStatus = {
  status: "running" | "done" | "error";
  extracted?: number;
  total?: number;
  error?: string;
  message?: string;
};

const extractions = new Map<string, ArchiveExtractionStatus>();

export async function startSSHArchiveExtraction(
  sessionId: string,
  archivePath: string,
  extractPath?: string,
): Promise<{ operationId: string; extractPath: string }> {
  const operationId = `${Date.now()}-${Math.random().toString(36).slice(2)}`;
  const into = extractPath ?? parentPath(archivePath);
  extractions.set(operationId, { status: "running" });
  clientFor(sessionId)
    .call("extract", { path: archivePath, to: into })
    .then(() => extractions.set(operationId, { status: "done" }))
    .catch((error) =>
      extractions.set(operationId, {
        status: "error",
        error: error instanceof Error ? error.message : String(error),
      }),
    );
  return { operationId, extractPath: into };
}

export async function getSSHArchiveExtractionStatus(
  _sessionId: string,
  operationId: string,
): Promise<ArchiveExtractionStatus> {
  return extractions.get(operationId) ?? { status: "error", error: "Unknown" };
}

export async function compressSSHFiles(
  sessionId: string,
  paths: string[],
  archiveName: string,
  _format?: string,
  _hostId?: number,
  _userId?: string,
): Promise<{ success: boolean; message: string; archivePath: string }> {
  const folder = parentPath(paths[0]);
  const name = /\.(tar\.gz|tgz)$/i.test(archiveName)
    ? archiveName
    : `${archiveName.replace(/\.[^./]+$/, "")}.tar.gz`;
  const archivePath = joinPath(folder, name);
  await clientFor(sessionId).call("compress", { paths, to: archivePath });
  return { success: true, message: "Archive created", archivePath };
}

export type HostConnectionState =
  "disconnected" | "connecting" | "ready" | "auth_required" | "error";

export interface EnsureSSHSessionResult {
  state: HostConnectionState;
  sessionId?: string;
  error?: string;
}

export async function ensureSSHSessionForHost(host: {
  id: number;
}): Promise<EnsureSSHSessionResult> {
  const sessionId = String(host.id);
  if (isConnected(sessionId)) return { state: "ready", sessionId };
  try {
    await openSession(sessionId, sessionId);
    return { state: "ready", sessionId };
  } catch (error) {
    return {
      state: error instanceof AdbConnectError ? "error" : "disconnected",
      error: error instanceof Error ? error.message : String(error),
    };
  }
}

export interface BrowseSSHDirectoryResult {
  status: "ok" | "not_found" | "error";
  path: string;
  files: FileItem[];
}

export async function browseSSHDirectory(
  sessionId: string,
  path: string,
): Promise<BrowseSSHDirectoryResult> {
  try {
    const reply = await clientFor(sessionId).call("list", { path });
    return {
      status: "ok",
      path,
      files: (reply.entries ?? []).map((entry) => toFileItem(path, entry)),
    };
  } catch {
    return { status: "error", path, files: [] };
  }
}
