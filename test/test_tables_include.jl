# The Tables.jl surface, reached the way a NOTEBOOK reaches it.
#
# A notebook's cells do not run against a loaded KaimonSlate. The worker builds `Main.SlateWorker` by
# `include`ing the source (worker.jl: "This is NOT part of `using KaimonSlate`"), and Julia fires a
# package extension only for a package — so `ext/KaimonSlateTablesExt.jl` never loads there and
# `DataFrame(ds)` reported the dataset as not a table at all.
#
# test_dataset.jl covers the other half by doing `using KaimonSlate`, which is exactly the case that
# DOES load the extension — so it passed while the configuration every user runs was broken. This
# file is the counterpart: include the source into a bare module, like the worker, and check the
# methods are there anyway.
using ReTest
import Tables, DataFrames

# A module built the worker's way: no package, just the source.
module Included
    include(joinpath(@__DIR__, "..", "src", "sweep.jl"))
end
const IS = Included.Sweep

@testset "tables (included, not loaded)" begin
    @testset "the Tables surface exists without a package extension" begin
        # `include` gives no extension, so anything below can only work because the methods were
        # defined at MODULE-LOAD time. That timing is the contract: defining them later, when a cell
        # first needs them, lands them in a newer world than the frame that asked, so the cell that
        # triggered it cannot see them.
        @test Base.get_extension(Included, :KaimonSlateTablesExt) === nothing
        @test Tables.istable(IS.Dataset)
        @test Tables.columnaccess(IS.Dataset)

        mktempdir() do root
            t = IS.LocalTarget(; root, project = tempdir(), chunk = 2,
                               payload = joinpath(@__DIR__, "..", "src", "slatetask.jl"))
            r = IS.@sweep(IS.paramgrid(g = 1:3), t; submit = false) do p
                (; i = collect(1:4), v = float.(1:4) .* p.g)
            end
            for c in IS.BatchSweep.sweep_chunks(root, r.run); IS.SlateTask.run_chunk(root, c); end
            ds = IS.refresh!(r).dataset
            @test length(ds) == 12
            # `DataFrame(ds)` IS `DataFrame(ds[:])` — columns, so projection and chunk pruning are
            # intact and nothing is built per row.
            @test Tables.columns(ds) == ds[:]

            # The three things a consumer asks for, none of which existed through this path before.
            @test DataFrames.nrow(DataFrames.DataFrame(ds)) == 12
            @test length(collect(Tables.partitions(ds))) >= 1
            sch = Tables.schema(ds)
            @test sch.names == (:g, :i, :v)
            @test sch.types == (Int64, Int64, Float64)
        end
    end
end
