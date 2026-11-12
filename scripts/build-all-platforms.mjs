const platformCommands = {
  win32: 'npm run dist:win',
  darwin: 'npm run dist:mac',
  linux: 'npm run dist:linux',
}

const command = platformCommands[process.platform]

if (!command) {
  console.error(`Unsupported local build platform: ${process.platform}`)
  process.exit(1)
}

console.log('Gaoge Free uses native runners for release bundles:')
console.log('  Windows -> npm run dist:win')
console.log('  macOS   -> npm run dist:mac')
console.log('  Linux   -> npm run dist:linux')
console.log('')
console.log('To build all three platforms from one source change, run the GitHub Release Build workflow.')
console.log(`On this machine, run: ${command}`)
