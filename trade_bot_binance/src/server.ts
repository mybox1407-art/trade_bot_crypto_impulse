import { app } from './app';
import { env } from './config/env';

app.listen(env.port, '0.0.0.0', () => {
  console.log(`Server started on port ${env.port}`);
});
