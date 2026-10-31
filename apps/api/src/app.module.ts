import { Module, type DynamicModule } from '@nestjs/common';
import { APP_FILTER, APP_GUARD, APP_INTERCEPTOR } from '@nestjs/core';
import { ThrottlerGuard, ThrottlerModule } from '@nestjs/throttler';
import type { AppConfig } from '@voxstudio/core';
import { AdminController } from './admin/admin.controller';
import { AssetsController } from './assets/assets.controller';
import { AuthController } from './auth/auth.controller';
import { AuthService } from './auth/auth.service';
import { SessionGuard } from './auth/guards';
import { CatalogController } from './catalog/catalog.controller';
import { CatalogService } from './catalog/catalog.service';
import { AccessService } from './common/access';
import { AuditService } from './common/audit';
import { EnvelopeInterceptor, ErrorFilter } from './common/http';
import { InfraModule } from './common/infra';
import { HealthController } from './health/health.controller';
import { PresetSeeder, PresetsController } from './presets/presets';
import { ProjectsController } from './projects/projects.controller';
import { ProjectsService } from './projects/projects.service';
import { PronunciationController } from './pronunciation/pronunciation.controller';
import { JobEventsService } from './render/events.service';
import { PlannerService } from './render/planner';
import { RenderController } from './render/render.controller';
import { RenderService } from './render/render.service';

@Module({})
export class AppModule {
  static forRoot(config: AppConfig): DynamicModule {
    return {
      module: AppModule,
      imports: [
        InfraModule.forRoot(config),
        ThrottlerModule.forRoot({
          throttlers: [{ name: 'default', ttl: 60_000, limit: config.env === 'test' ? 10_000 : 600 }],
        }),
      ],
      controllers: [
        AuthController,
        HealthController,
        ProjectsController,
        CatalogController,
        RenderController,
        PresetsController,
        PronunciationController,
        AssetsController,
        AdminController,
      ],
      providers: [
        AuthService,
        AccessService,
        AuditService,
        CatalogService,
        PlannerService,
        ProjectsService,
        RenderService,
        JobEventsService,
        PresetSeeder,
        // Order matters: authenticate first, then rate-limit.
        { provide: APP_GUARD, useClass: SessionGuard },
        { provide: APP_GUARD, useClass: ThrottlerGuard },
        { provide: APP_INTERCEPTOR, useClass: EnvelopeInterceptor },
        { provide: APP_FILTER, useClass: ErrorFilter },
      ],
    };
  }
}
