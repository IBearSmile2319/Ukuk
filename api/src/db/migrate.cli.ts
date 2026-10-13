import { migrate } from './migrate';

const url = process.env.MIGRATION_DATABASE_URL ?? process.env.DATABASE_URL;
if (!url) {
  console.error('Define MIGRATION_DATABASE_URL o DATABASE_URL');
  process.exit(1);
}
migrate(url, console.log).catch((err) => {
  console.error(err.message);
  process.exit(1);
});
