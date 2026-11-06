import { Injectable, type CanActivate } from "@nestjs/common";

// Este guard é o ponto de integração entre a identidade do IdP e o providerId da requisição.
@Injectable()
export class GuardaProvedorLocal implements CanActivate {
  // O ambiente demonstrativo é local e não autentica requisições.
  canActivate(): boolean { return true; }
}
