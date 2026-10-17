import { optionsFromArgs, storePassword } from "./store-password";

try {
  const { key, location } = await storePassword(
    optionsFromArgs(process.argv.slice(2), process.env.DRIVES),
  );

  console.log(`KV key:  ${key}`);
  console.log(`Stored in ${location}.`);
} catch (error) {
  console.error(error instanceof Error ? error.message : String(error));
  process.exit(1);
}
