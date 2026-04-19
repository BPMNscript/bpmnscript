import type { ValidationAcceptor, ValidationChecks } from 'langium';
import type { BpmnScriptAstType, Person } from './generated/ast.js';
import type { BpmnScriptServices } from './bpmn-script-module.js';

/**
 * Register custom validation checks.
 */
export function registerValidationChecks(services: BpmnScriptServices) {
    const registry = services.validation.ValidationRegistry;
    const validator = services.validation.BpmnScriptValidator;
    const checks: ValidationChecks<BpmnScriptAstType> = {
        Person: validator.checkPersonStartsWithCapital
    };
    registry.register(checks, validator);
}

/**
 * Implementation of custom validations.
 */
export class BpmnScriptValidator {

    checkPersonStartsWithCapital(person: Person, accept: ValidationAcceptor): void {
        if (person.name) {
            const firstChar = person.name.substring(0, 1);
            if (firstChar.toUpperCase() !== firstChar) {
                accept('warning', 'Person name should start with a capital.', { node: person, property: 'name' });
            }
        }
    }

}
