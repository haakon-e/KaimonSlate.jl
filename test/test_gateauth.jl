# src/gateauth.jl — how the worker decides whether its CURVE channels allow-list their clients.
#
# The predicate is included here on its own rather than reached for through `SlateWorker`: that
# module imports KaimonGate, which KaimonSlate deliberately does not depend on, so the suite cannot
# load it. Keeping the rule in a pure file is what makes it testable at all.
using ReTest
include(joinpath(@__DIR__, "..", "src", "gateauth.jl"))

@testset "gate auth switches" begin
    @testset "an unreadable allow-any setting means ENFORCE" begin
        # The bug this pins: the answer used to come from KaimonGate's internals, which are not
        # module-level names in every release. The lookup threw, the `catch` returned "do not
        # enforce", and the blob channel bound every interface with no allow-list behind it.
        @test blob_enforce(Dict{String,String}())                   # unset
        @test blob_enforce(Dict("KAIMON_GATE_CURVE_ALLOW_ANY" => ""))
        @test blob_enforce(Dict("KAIMON_GATE_CURVE_ALLOW_ANY" => "maybe"))   # unparseable
        @test blob_enforce(Dict("KAIMON_GATE_CURVE_ALLOW_ANY" => "0"))
        @test blob_enforce(Dict("KAIMON_GATE_CURVE_ALLOW_ANY" => "false"))
        # Only an explicit yes turns it off, and that is the operator saying so.
        for v in ("1", "true", "yes", "on", "TRUE", " On ")
            @test !blob_enforce(Dict("KAIMON_GATE_CURVE_ALLOW_ANY" => v))
        end
        # The real process environment, which is what the worker actually reads. Slate never sets
        # this, so a worker enforces unless someone put it there on purpose.
        @test !haskey(ENV, "KAIMON_GATE_CURVE_ALLOW_ANY")
        @test blob_enforce()
    end

    @testset "truthy is spelled the way KaimonGate spells it" begin
        # Both ends read one setting. If they disagreed about what the operator wrote, the gate and
        # its data channel would take different postures from the same word.
        @test all(gate_truthy, ("1", "true", "yes", "on", "YES", "\tTrue\n"))
        @test !any(gate_truthy, ("0", "false", "no", "off", "", " ", "2", "true-ish"))
    end
end
