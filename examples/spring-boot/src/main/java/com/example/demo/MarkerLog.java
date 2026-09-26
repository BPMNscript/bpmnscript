package com.example.demo;

import org.operaton.bpm.engine.delegate.Expression;
import org.operaton.bpm.engine.delegate.VariableScope;

/**
 * The ordered trace of engine callbacks, one comma separated process variable
 * so a single read shows what ran and in which order.
 */
final class MarkerLog {

    private static final String VARIABLE = "listenerLog";

    private MarkerLog() {
    }

    static void append(VariableScope scope, String marker) {
        Object recorded = scope.getVariable(VARIABLE);
        scope.setVariable(VARIABLE, recorded == null ? marker : recorded + "," + marker);
    }

    /**
     * The injected field is an {@link Expression} rather than a {@code String}
     * because the engine hands a literal and a {@code ${...}} body over the
     * same slot, and refuses any other field type when it first instantiates
     * the delegate.
     */
    static String injected(Expression field, VariableScope scope) {
        return field == null ? "" : ":" + field.getValue(scope);
    }
}
