import { Module } from '@nestjs/common';
import { AccountController } from './account.controller';
import { AdminController } from './admin.controller';
import { HealthController } from './health.controller';

@Module({ controllers: [AdminController, AccountController, HealthController] })
export class AdminModule {}
