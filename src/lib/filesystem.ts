export interface PermissionCapableDirectoryHandle extends FileSystemDirectoryHandle {
  queryPermission?: (descriptor?: { mode?: 'read' | 'readwrite' }) => Promise<PermissionState>
  requestPermission?: (descriptor?: { mode?: 'read' | 'readwrite' }) => Promise<PermissionState>
}

export function asPermissionHandle(handle: FileSystemDirectoryHandle) {
  return handle as PermissionCapableDirectoryHandle
}
