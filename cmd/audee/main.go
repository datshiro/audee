package main

import (
	"errors"
	"fmt"
	"os"

	"github.com/spf13/cobra"
)

// version is set at build time with -ldflags "-X main.version=v0.1.0".
var version = "dev"

// errLogged marks an error already written through the redacting logger.
var errLogged = errors.New("see log")

func main() {
	root := &cobra.Command{
		Use:           "audee",
		Short:         "Self-hosted agent gateway",
		SilenceErrors: true,
		SilenceUsage:  true,
	}
	root.AddCommand(serveCmd(), &cobra.Command{
		Use:   "version",
		Short: "Print the version",
		Run: func(cmd *cobra.Command, _ []string) {
			fmt.Fprintln(cmd.OutOrStdout(), version)
		},
	})
	if err := root.Execute(); err != nil {
		if !errors.Is(err, errLogged) {
			fmt.Fprintln(os.Stderr, "audee:", err)
		}
		os.Exit(1)
	}
}
