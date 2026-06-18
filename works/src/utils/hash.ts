export async function computeFileHash(
  fileName: string,
  fileSize: number,
  mimeType: string,
  fileUniqueId: string
): Promise<string> {
  const input = `${fileName}:${fileSize}:${mimeType}:${fileUniqueId}`
  const buf = await crypto.subtle.digest('SHA-256', new TextEncoder().encode(input))
  return Array.from(new Uint8Array(buf)).map(b => b.toString(16).padStart(2, '0')).join('')
}

export function getShortHash(fullHash: string, length: number): string {
  return fullHash.slice(0, length)
}

export function checkHash(hashParam: string, storedHash: string, length: number): boolean {
  return hashParam === getShortHash(storedHash, length)
}
